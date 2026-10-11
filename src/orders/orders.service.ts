import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  BadRequestError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from '../common/exceptions/index.js';
import { assertAdminCan } from '../common/admin-access.js';
import { assertShippingMove } from './shipping-rules.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import { ConfigService } from '@nestjs/config';
import {
  OrderStatus as DbOrderStatus,
  Prisma,
  TransactionKind,
} from '@prisma/client';
import {
  MarketplaceClient,
  StoresClient,
  UsersClient,
  type MarketplaceProductPrice,
  type NotificationType,
  type StoreProductPrice,
  type TransactionEmailStage,
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
  shippingStatus: { select: { id: true, status: true, trackingInfo: true } },
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
 * How a shipping transition reads to the buyer. Delivery is the end of the
 * transaction; a return or cancellation ends it the other way; the rest are
 * progress.
 */
const SHIPPING_STAGE_TO_EMAIL: Record<ShippingStage, TransactionEmailStage> = {
  [ShippingStage.PREPARING]: 'IN_PROCESS',
  [ShippingStage.SHIPPED]: 'IN_PROCESS',
  [ShippingStage.DELIVERED]: 'COMPLETED',
  [ShippingStage.RETURNED]: 'REFUNDED',
  [ShippingStage.CANCELED]: 'CANCELLED',
};

/** Which notification type each shipping transition raises. */
const SHIPPING_STAGE_TO_TYPE: Record<ShippingStage, NotificationType> = {
  [ShippingStage.PREPARING]: 'ORDER_CONFIRMED',
  [ShippingStage.SHIPPED]: 'ORDER_SHIPPED',
  [ShippingStage.DELIVERED]: 'ORDER_DELIVERED',
  [ShippingStage.RETURNED]: 'PAYMENT_REFUNDED',
  [ShippingStage.CANCELED]: 'ORDER_CANCELLED',
};

/** Shipping detail added to the email body, since the stage alone is coarse. */
const SHIPPING_STAGE_NOTE: Record<ShippingStage, string> = {
  [ShippingStage.PREPARING]: 'El vendedor está preparando tu pedido',
  [ShippingStage.SHIPPED]: 'Tu pedido va en camino',
  [ShippingStage.DELIVERED]: 'Tu pedido fue entregado',
  [ShippingStage.RETURNED]: 'Tu pedido fue devuelto',
  [ShippingStage.CANCELED]: 'El envío fue cancelado',
};

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
    private readonly users: UsersClient,
    private readonly config: ConfigService,
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

  /**
   * Orders a seller received, newest first. `status` filters on the payment
   * state and `stage` on the shipping stage, so the sales area can ask for
   * "paid and still preparing" — the orders waiting to ship (WEB-1).
   */
  async getOrdersBySeller({
    sellerId,
    page,
    pageSize,
    status,
    stage,
  }: {
    sellerId: string;
    page: number;
    pageSize: number;
    status?: OrderStatus;
    stage?: ShippingStage;
  }) {
    return this._paginatedOrders(
      {
        sellerId,
        ...(status && { status }),
        ...(stage && { shippingStatus: { status: stage } }),
      },
      page,
      pageSize,
    );
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

      void this._notifyOrderParties(order.id, 'STARTED', 'ORDER_RECEIVED');

      return this._mapOrder(order);
    } catch (error) {
      this.logger.error('Error al crear la orden:', error);
      throw new InternalServerError('Error al crear la orden');
    }
  }

  /**
   * The order's seller moves its shipping forward; anyone else needs to be a
   * platform admin with MANAGE_ORDERS (TRX-1). Before, anyone at all, signed
   * out included, could mark any order shipped or delivered.
   */
  async updateShipping({
    input,
    sellerId,
    adminId,
  }: {
    input: UpdateShippingInput;
    sellerId?: string;
    adminId?: string;
  }) {
    if (!sellerId && !adminId) {
      throw new UnauthorizedError('Debe iniciar sesión');
    }
    const orderId = parseInt(input.orderId, 10);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        sellerId: true,
        status: true,
        shippingStatusId: true,
        shippingStatus: { select: { status: true } },
      },
    });
    if (!order) throw new NotFoundError('Orden no encontrada');
    if (!sellerId || order.sellerId !== sellerId) {
      if (!adminId) {
        throw new ForbiddenError(
          'Solo el vendedor de la orden puede actualizar el envío',
        );
      }
      await assertAdminCan(this.prisma, adminId, 'MANAGE_ORDERS');
    }
    assertShippingMove({
      orderStatus: String(order.status),
      from: String(order.shippingStatus.status),
      to: input.stage,
    });

    try {
      // The tracking note belongs to the shipment, so only SHIPPED sets it;
      // later stages keep whatever the seller wrote then (WEB-1).
      const trackingInfo =
        input.stage === ShippingStage.SHIPPED
          ? input.trackingInfo?.trim() || null
          : undefined;
      await this.prisma.shippingStatus.update({
        where: { id: order.shippingStatusId },
        data: {
          status: input.stage,
          ...(trackingInfo !== undefined && { trackingInfo }),
        },
      });

      const updated = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: ORDER_SELECT,
      });

      // DELIVERED closes the transaction for the buyer; RETURNED/CANCELED end
      // it badly; anything else is just progress worth reporting.
      void this._notifyOrderParties(
        orderId,
        SHIPPING_STAGE_TO_EMAIL[input.stage],
        SHIPPING_STAGE_TO_TYPE[input.stage],
        trackingInfo
          ? `${SHIPPING_STAGE_NOTE[input.stage]} · Seguimiento: ${trackingInfo}`
          : SHIPPING_STAGE_NOTE[input.stage],
      );
      if (input.stage === ShippingStage.DELIVERED) {
        void this._awardOrderPoints(orderId);
      }

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
  async markPaid(orderId: number): Promise<boolean> {
    // Only PENDING_PAYMENT → PAID. A second payment for an order that is
    // already paid, or that expired, changes nothing here; the caller refunds
    // it (SettlementService.onCompleted).
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.PAID },
    });
    if (count > 0) {
      void this._notifyOrderParties(orderId, 'IN_PROCESS', 'ORDER_CONFIRMED');
    }
    return count > 0;
  }

  /**
   * A refund went through (TRX-2). A full refund closes the order as
   * REFUNDED; a partial one leaves it PAID. Both parties are told either way.
   */
  async markRefunded({
    orderId,
    full,
    amount,
  }: {
    orderId: number;
    full: boolean;
    amount: number;
  }): Promise<void> {
    if (full) {
      await this.prisma.order.updateMany({
        where: { id: orderId, status: OrderStatus.PAID },
        data: { status: OrderStatus.REFUNDED },
      });
    }
    void this._notifyOrderParties(
      orderId,
      'REFUNDED',
      'PAYMENT_REFUNDED',
      full
        ? 'Se reembolsó el total del pago'
        : `Se reembolsaron $${Math.round(amount).toLocaleString('es-CL')}`,
    );
  }

  /**
   * Marks an order CANCELED when the buyer abandons or the provider rejects.
   * Idempotent: only flips PENDING_PAYMENT → CANCELED.
   */
  async markCanceled(orderId: number) {
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.CANCELED },
    });
    // Idempotent upstream, so only notify on the transition that actually
    // happened — a repeated webhook must not re-send the email.
    if (count > 0) {
      void this._notifyOrderParties(orderId, 'CANCELLED', 'ORDER_CANCELLED');
    }
  }

  // ─── eco-points ───────────────────────────────────────────────────────────

  /**
   * Eco-points for a delivered order (ekoru-users docs/POINTS.md). The buyer
   * earns STOREPURCHASE (PURCHASE when the order holds only marketplace items)
   * and the seller earns SELL. Marketplace items also earn impact points for
   * the CO2 and water a second-hand item saves. Store items earn none for now:
   * their figures overstate the saving of a new product until decision D3.
   *
   * Only a PAID order earns anything. The users engine pays each seller once
   * per `order:<id>`, so a repeated DELIVERED update pays nothing more, and
   * the points go to the order's own buyer and seller whoever marks it
   * delivered. Best-effort: a failure is logged and never fails the shipping
   * update. A later return does not take the points back.
   */
  private async _awardOrderPoints(orderId: number): Promise<void> {
    const reference = `order:${orderId}`;
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          buyerId: true,
          sellerId: true,
          orderItem: {
            select: { productId: true, storeProductId: true, quantity: true },
          },
        },
      });
      if (!order || order.status !== DbOrderStatus.PAID) return;

      const marketplaceItems = order.orderItem.filter(
        (item) => item.productId !== null,
      );
      const impacts = await this.marketplace.getImpacts(
        marketplaceItems.map((item) => item.productId!),
      );
      let co2SavingsKG = 0;
      let waterSavingsLT = 0;
      for (const item of marketplaceItems) {
        const impact = impacts.get(item.productId!);
        if (!impact) continue;
        const quantity = Math.max(1, item.quantity ?? 1);
        co2SavingsKG += impact.co2SavingsKG * quantity;
        waterSavingsLT += impact.waterSavingsLT * quantity;
      }

      const buyerKind = order.orderItem.some(
        (item) => item.storeProductId !== null,
      )
        ? TransactionKind.STOREPURCHASE
        : TransactionKind.PURCHASE;
      const awards = [
        { sellerId: order.buyerId, kind: buyerKind },
        { sellerId: order.sellerId, kind: TransactionKind.SELL },
      ];

      const credited = await Promise.all(
        awards.map((award) =>
          this.users.awardActivityPoints({
            ...award,
            reference,
            co2SavingsKG,
            waterSavingsLT,
          }),
        ),
      );

      // Keep this service's own ledger in step (it is not the source of
      // truth any more; users' PointsAward is). Only fresh awards are
      // written, so a repeated update adds nothing.
      const rows = awards
        .map((award, index) => ({
          sellerId: award.sellerId,
          kind: award.kind,
          pointsCollected: credited[index],
          notes: reference,
        }))
        .filter((row) => row.pointsCollected > 0);
      if (rows.length) await this.prisma.transaction.createMany({ data: rows });
    } catch (error) {
      this.logger.error(`Awarding points failed for order ${orderId}`, error);
    }
  }

  // ─── notifications ────────────────────────────────────────────────────────

  /**
   * Emails buyer and seller about an order transition.
   *
   * Best-effort throughout: the users subgraph applies each recipient's
   * `SellerPreferences` gate and decides whether anything is actually sent, and
   * every failure here is swallowed — a paid order stays paid even if no email
   * could go out.
   */
  private async _notifyOrderParties(
    orderId: number,
    stage: TransactionEmailStage,
    type: NotificationType,
    note?: string,
  ): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          buyerId: true,
          sellerId: true,
          total: true,
          currency: true,
          orderItem: {
            select: {
              productId: true,
              storeProductId: true,
              quantity: true,
            },
          },
        },
      });
      if (!order) return;

      const shared = {
        type,
        stage,
        reference: `#${order.id}`,
        summary: await this._orderSummary(order.orderItem),
        amount: order.total,
        currency: order.currency,
        note: note ?? null,
        relatedId: String(order.id),
      };

      await Promise.all([
        this.users.notifyTransaction(order.buyerId, {
          ...shared,
          role: 'BUYER',
          detailUrl: this._orderUrl('BUYER'),
        }),
        this.users.notifyTransaction(order.sellerId, {
          ...shared,
          role: 'SELLER',
          detailUrl: this._orderUrl('SELLER'),
        }),
      ]);
    } catch (err) {
      this.logger.error(`Order ${orderId} notifications failed`, err);
    }
  }

  /**
   * "Chaqueta de mezclilla, Bicicleta urbana (+2)". Falls back to the line
   * count if either products subgraph is unavailable — the notification
   * matters more than the description in it.
   */
  private async _orderSummary(
    items: Array<{
      productId: number | null;
      storeProductId: number | null;
      quantity: number;
    }>,
  ): Promise<string> {
    const units = items.reduce((sum, i) => sum + i.quantity, 0);
    const fallback = `${units} ${units === 1 ? 'producto' : 'productos'}`;

    const marketplaceIds = items
      .map((i) => i.productId)
      .filter((id): id is number => typeof id === 'number');
    const storeIds = items
      .map((i) => i.storeProductId)
      .filter((id): id is number => typeof id === 'number');

    try {
      const [marketplaceProducts, storeProducts] = await Promise.all([
        marketplaceIds.length
          ? this.marketplace.getPrices(marketplaceIds)
          : Promise.resolve<MarketplaceProductPrice[]>([]),
        storeIds.length
          ? this.stores.getPrices(storeIds)
          : Promise.resolve<StoreProductPrice[]>([]),
      ]);

      const names = [...marketplaceProducts, ...storeProducts]
        .map((p) => p.name)
        .filter(Boolean);
      if (names.length === 0) return fallback;
      // Two names plus a count keeps subject lines and spec rows readable.
      const shown = names.slice(0, 2).join(', ');
      return names.length > 2 ? `${shown} (+${names.length - 2})` : shown;
    } catch {
      return fallback;
    }
  }

  /**
   * Deep link for the email CTA. Points at the orders list, not a per-order
   * page: the web app has no order-detail route, so an id in the path would
   * 404. The notification carries `relatedId` separately, so clients can route
   * more precisely once such a page exists.
   *
   * Locale-less on purpose — the web app's proxy redirects `/profile/orders` to
   * the visitor's `/{lang}/profile/orders`.
   */
  /** The buyer's order history, or the seller's sales area (WEB-1). */
  private _orderUrl(role: 'BUYER' | 'SELLER'): string {
    const base = this.config.get<string>('webAppBaseUrl');
    if (!base) return '';
    return `${base}/profile/${role === 'SELLER' ? 'sales' : 'orders'}`;
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** Any filter, for the admin orders list (TRX-11). Callers check access. */
  listOrders({
    where,
    page,
    pageSize,
  }: {
    where: Prisma.OrderWhereInput;
    page: number;
    pageSize: number;
  }) {
    return this._paginatedOrders(where, page, pageSize);
  }

  private async _paginatedOrders(
    where: Prisma.OrderWhereInput,
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
