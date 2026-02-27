import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  NotFoundError,
  InternalServerError,
} from '../common/exceptions/index.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import { CreateOrderInput, UpdateShippingInput } from './dto/index.js';
import { ShippingStage } from '../graphql/enums/index.js';

const ORDER_SELECT = {
  id: true,
  sellerId: true,
  shippingStatusId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  shippingStatus: {
    select: { id: true, status: true },
  },
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

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getOrder(id: number) {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id },
        select: ORDER_SELECT,
      });

      if (!order) throw new NotFoundError('Orden no encontrada');

      return {
        ...order,
        orderItems: order.orderItem,
        seller: { id: order.sellerId },
      };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al obtener la orden:', error);
      throw new InternalServerError('Error al obtener la orden');
    }
  }

  async getOrdersBySeller(sellerId: string, page: number, pageSize: number) {
    try {
      const { skip, take } = calculatePrismaParams(page, pageSize);

      const count = await this.prisma.order.count({ where: { sellerId } });
      const orders = await this.prisma.order.findMany({
        where: { sellerId },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: ORDER_SELECT,
      });

      const mapped = orders.map((o) => ({
        ...o,
        orderItems: o.orderItem,
        seller: { id: o.sellerId },
      }));

      return createPaginatedResponse(mapped, count, page, pageSize);
    } catch (error) {
      this.logger.error('Error al obtener órdenes del vendedor:', error);
      throw new InternalServerError('Error al obtener órdenes del vendedor');
    }
  }

  /**
   * Creates an order with its items atomically.
   * A new ShippingStatus row is also created starting at PREPARING.
   */
  async createOrder(input: CreateOrderInput) {
    try {
      // Use a transaction to create shipping status + order + items atomically
      const order = await this.prisma.$transaction(async (tx) => {
        const shippingStatus = await tx.shippingStatus.create({
          data: { status: ShippingStage.PREPARING },
        });

        return tx.order.create({
          data: {
            sellerId: input.sellerId,
            shippingStatusId: shippingStatus.id,
            orderItem: {
              create: input.items.map((item) => ({
                productId: item.productId,
                storeProductId: item.storeProductId,
                quantity: item.quantity,
                price: item.price,
              })),
            },
          },
          select: ORDER_SELECT,
        });
      });

      return {
        ...order,
        orderItems: order.orderItem,
        seller: { id: order.sellerId },
      };
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

      return {
        ...updated!,
        orderItems: updated!.orderItem,
        seller: { id: updated!.sellerId },
      };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al actualizar el estado de envío:', error);
      throw new InternalServerError('Error al actualizar el estado de envío');
    }
  }
}
