import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  BadRequestError,
  InternalServerError,
  NotFoundError,
} from '../common/exceptions/index.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import {
  MarketplaceClient,
  StoresClient,
  type MarketplaceProductPrice,
  type StoreProductPrice,
} from '../common/clients/index.js';
import { CreateOrderInput, UpdateShippingInput } from './dto/index.js';
import {
  OrderStatus,
  ShippingMethod,
  ShippingStage,
} from '../graphql/enums/index.js';

const ORDER_SELECT = {
  id: true,
  buyerId: true,
  sellerId: true,
  status: true,
  subtotal: true,
  shippingCost: true,
  taxAmount: true,
  total: true,
  currency: true,
  shippingMethod: true,
  shippingAddressId: true,
  shippingStatusId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  shippingStatus: { select: { id: true, status: true } },
  shippingAddress: true,
  orderItem: {
    select: {
      id: true,
      orderId: true,
      productId: true,
      storeProductId: true,
      quantity: true,
      price: true,
      createdAt: true,
    },
  },
} as const;

/**
 * Methods that require a delivery address. `IN_HOUSE_PICKUP` happens at the
 * seller's address, `IN_MID_POINT_PICKUP` is coordinated by chat and is not
 * payable through this flow.
 */
const ADDRESS_REQUIRED = new Set<ShippingMethod>([
  ShippingMethod.DELIVERED_TO_HOME,
  ShippingMethod.CARRIER,
]);

/**
 * Flat-rate shipping costs in CLP for the v1 launch. Replace with a per-seller
 * shippingPolicy + carrier-quote API call once those land in the marketplace
 * subgraph. See docs/CHECKOUT.md §3.9.
 */
const FLAT_SHIPPING_COST_CLP: Record<ShippingMethod, number> = {
  [ShippingMethod.DELIVERED_TO_HOME]: 3990,
  [ShippingMethod.IN_HOUSE_PICKUP]: 0,
  [ShippingMethod.IN_MID_POINT_PICKUP]: 0,
  // Carrier should be quoted live; reject the order until that's wired.
  [ShippingMethod.CARRIER]: -1,
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketplace: MarketplaceClient,
    private readonly stores: StoresClient,
  ) {}

  async getOrder(id: number) {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id },
        select: ORDER_SELECT,
      });
      if (!order) throw new NotFoundError('Orden no encontrada');
      return this._mapOrder(order);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al obtener la orden:', error);
      throw new InternalServerError('Error al obtener la orden');
    }
  }

  async getOrdersBySeller({
    sellerId,
    page,
    pageSize,
  }: {
    sellerId: string;
    page: number;
    pageSize: number;
  }) {
    return this._paginatedOrders({ sellerId }, page, pageSize);
  }

  async getOrdersByBuyer({
    buyerId,
    page,
    pageSize,
  }: {
    buyerId: string;
    page: number;
    pageSize: number;
  }) {
    return this._paginatedOrders({ buyerId }, page, pageSize);
  }

  /**
   * Creates an order with totals computed from canonical product prices.
   * The buyer ID is taken from the authenticated session — never from input.
   *
   * Flow:
   *   1. Look up canonical product prices from the marketplace subgraph.
   *   2. Validate every product is active and belongs to one seller.
   *      (Multi-seller carts are out of scope for v1 — see docs/CHECKOUT.md §5.)
   *   3. Compute subtotal, shippingCost (flat-rate for now), taxAmount = 0,
   *      and total.
   *   4. Persist Order + OrderItems + ShippingStatus + (optionally) ShippingAddress
   *      atomically. Status starts at PENDING_PAYMENT.
   */
  async createOrder({
    input,
    buyerId,
  }: {
    input: CreateOrderInput;
    buyerId: string;
  }) {
    if (!buyerId) {
      throw new BadRequestError('Debe iniciar sesión para crear una orden');
    }

    if (input.currency !== 'CLP') {
      throw new BadRequestError(
        'Solo se acepta CLP en esta etapa. Multi-moneda llegará después.',
      );
    }

    const needsAddress = ADDRESS_REQUIRED.has(input.shippingMethod);
    if (needsAddress && !input.shippingAddress) {
      throw new BadRequestError('Esta forma de envío requiere una dirección');
    }
    if (input.shippingMethod === ShippingMethod.IN_MID_POINT_PICKUP) {
      throw new BadRequestError(
        'El punto intermedio se coordina por chat, no por pago en línea',
      );
    }

    // Each line is either a marketplace product or a store product — never both,
    // never neither.
    for (const item of input.items) {
      const hasMarketplace = typeof item.productId === 'number';
      const hasStore = typeof item.storeProductId === 'number';
      if (hasMarketplace === hasStore) {
        throw new BadRequestError(
          'Cada ítem debe referenciar exactamente un productId (marketplace) o storeProductId (tienda)',
        );
      }
    }

    // 1. Resolve canonical prices from each owning subgraph in parallel.
    const marketplaceIds = input.items
      .map((i) => i.productId)
      .filter((id): id is number => typeof id === 'number');
    const storeIds = input.items
      .map((i) => i.storeProductId)
      .filter((id): id is number => typeof id === 'number');

    const [marketplaceProducts, storeProducts] = await Promise.all([
      marketplaceIds.length
        ? this.marketplace.getPrices(marketplaceIds)
        : Promise.resolve<MarketplaceProductPrice[]>([]),
      storeIds.length
        ? this.stores.getPrices(storeIds)
        : Promise.resolve<StoreProductPrice[]>([]),
    ]);

    // 2. Validate availability. Store products also carry stock; marketplace
    //    listings are single-quantity used goods with no stock counter.
    const inactive = [
      ...marketplaceProducts
        .filter((p) => !p.isActive)
        .map((p) => `mkt:${p.id}`),
      ...storeProducts.filter((p) => !p.isActive).map((p) => `store:${p.id}`),
    ];
    if (inactive.length > 0) {
      throw new BadRequestError(
        `Productos no disponibles: ${inactive.join(', ')}`,
      );
    }

    const storeStockById = new Map(storeProducts.map((p) => [p.id, p.stock]));
    for (const item of input.items) {
      if (typeof item.storeProductId !== 'number') continue;
      const stock = storeStockById.get(item.storeProductId) ?? 0;
      if (item.quantity > stock) {
        throw new BadRequestError(
          `Stock insuficiente para el producto de tienda ${item.storeProductId} (disponible: ${stock})`,
        );
      }
    }

    // 3. Single-seller across BOTH sources — an order belongs to one seller.
    const sellerIds = Array.from(
      new Set([
        ...marketplaceProducts.map((p) => p.sellerId),
        ...storeProducts.map((p) => p.sellerId),
      ]),
    );
    if (sellerIds.length > 1) {
      throw new BadRequestError(
        'Tu carrito tiene productos de más de un vendedor. Por ahora debes pagar cada vendedor por separado.',
      );
    }
    const sellerId = sellerIds[0];
    if (!sellerId) {
      throw new BadRequestError('No se pudo determinar el vendedor');
    }
    if (sellerId === buyerId) {
      throw new BadRequestError('No puedes comprarte productos a ti mismo');
    }

    // 4. Compute totals from canonical prices. Store products honour an active
    //    offer; marketplace products have no offer concept.
    const mktPriceById = new Map(
      marketplaceProducts.map((p) => [p.id, p.price]),
    );
    const storePriceById = new Map(
      storeProducts.map((p) => [
        p.id,
        p.hasOffer && p.offerPrice ? p.offerPrice : p.price,
      ]),
    );

    let subtotal = 0;
    const lineItems = input.items.map((item) => {
      const isStore = typeof item.storeProductId === 'number';
      const unitPrice = isStore
        ? storePriceById.get(item.storeProductId!)
        : mktPriceById.get(item.productId!);
      if (typeof unitPrice !== 'number') {
        const ref = isStore
          ? `de tienda ${item.storeProductId}`
          : `${item.productId}`;
        throw new BadRequestError(`Producto ${ref} sin precio`);
      }
      subtotal += unitPrice * item.quantity;
      return {
        productId: isStore ? undefined : item.productId,
        storeProductId: isStore ? item.storeProductId : undefined,
        quantity: item.quantity,
        price: unitPrice,
      };
    });

    const shippingCost = FLAT_SHIPPING_COST_CLP[input.shippingMethod];
    if (shippingCost < 0) {
      throw new BadRequestError(
        'Cotización de courier aún no disponible. Selecciona otro método.',
      );
    }
    const taxAmount = 0; // IVA already included in retail prices for v1.
    const total = subtotal + shippingCost + taxAmount;

    // 4. Persist.
    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const shippingStatus = await tx.shippingStatus.create({
          data: { status: ShippingStage.PREPARING },
        });

        const shippingAddressId =
          needsAddress && input.shippingAddress
            ? (
                await tx.shippingAddress.create({
                  data: { ...input.shippingAddress },
                  select: { id: true },
                })
              ).id
            : undefined;

        return tx.order.create({
          data: {
            buyerId,
            sellerId,
            status: OrderStatus.PENDING_PAYMENT,
            subtotal,
            shippingCost,
            taxAmount,
            total,
            currency: input.currency,
            shippingMethod: input.shippingMethod,
            shippingAddressId,
            shippingStatusId: shippingStatus.id,
            orderItem: { create: lineItems },
          },
          select: ORDER_SELECT,
        });
      });

      this.logger.log(
        `Orden ${order.id} creada — buyer=${buyerId} seller=${sellerId} total=${total} ${input.currency}`,
      );

      return this._mapOrder(order);
    } catch (error) {
      this.logger.error('Error al crear la orden:', error);
      throw new InternalServerError('Error al crear la orden');
    }
  }

  async updateShipping(input: UpdateShippingInput) {
    try {
      const orderId = parseInt(input.orderId, 10);
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { shippingStatusId: true },
      });
      if (!order) throw new NotFoundError('Orden no encontrada');

      await this.prisma.shippingStatus.update({
        where: { id: order.shippingStatusId },
        data: { status: input.stage },
      });

      const updated = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: ORDER_SELECT,
      });
      return this._mapOrder(updated!);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al actualizar el estado de envío:', error);
      throw new InternalServerError('Error al actualizar el estado de envío');
    }
  }

  /**
   * Marks an order as PAID. Called from `PaymentsService` after the provider
   * confirms a successful charge (via the webhook handler).
   */
  async markPaid(orderId: number) {
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PAID },
    });
  }

  /**
   * Marks an order CANCELED when the buyer abandons or the provider rejects.
   * Idempotent: only flips PENDING_PAYMENT → CANCELED.
   */
  async markCanceled(orderId: number) {
    await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.CANCELED },
    });
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async _paginatedOrders(
    where: { sellerId?: string; buyerId?: string },
    page: number,
    pageSize: number,
  ) {
    try {
      const { skip, take } = calculatePrismaParams(page, pageSize);
      const count = await this.prisma.order.count({ where });
      const orders = await this.prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: ORDER_SELECT,
      });
      return createPaginatedResponse(
        orders.map((o) => this._mapOrder(o)),
        count,
        page,
        pageSize,
      );
    } catch (error) {
      this.logger.error('Error al obtener órdenes:', error);
      throw new InternalServerError('Error al obtener órdenes');
    }
  }

  private _mapOrder<
    T extends { orderItem: unknown; sellerId: string; buyerId: string },
  >(o: T) {
    const { orderItem, ...rest } = o;
    return {
      ...rest,
      orderItems: orderItem,
      seller: { id: o.sellerId },
      buyer: { id: o.buyerId },
    };
  }
}
