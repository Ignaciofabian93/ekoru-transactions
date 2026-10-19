import { OrdersService } from './orders.service.js';
import { ShippingStage } from '../graphql/enums/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  MarketplaceClient,
  StoresClient,
  UsersClient,
} from '../common/clients/index.js';
import type { ConfigService } from '@nestjs/config';

function make(order: Record<string, unknown> | null, adminRow?: object) {
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    shippingStatus: { update: jest.fn().mockResolvedValue({}) },
    chileanPaymentConfig: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockResolvedValue(adminRow ? [adminRow] : []),
  };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {} as MarketplaceClient,
    {} as StoresClient,
    { notifyTransaction: jest.fn() } as unknown as UsersClient,
    { get: jest.fn() } as unknown as ConfigService,
  );
  return { service, prisma };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { extensions?: { code?: string } }).extensions?.code;
  }
};

describe('OrdersService', () => {
  const paidOrder = {
    sellerId: 'seller',
    status: 'PAID',
    shippingStatusId: 5,
    shippingStatus: { status: 'PREPARING' },
  };
  const ship = (
    sellerId?: string,
    adminId?: string,
    extra: { stage?: ShippingStage; trackingInfo?: string } = {},
  ) => ({
    input: { orderId: '42', stage: ShippingStage.SHIPPED, ...extra },
    sellerId,
    adminId,
  });

  describe('updateShipping (TRX-1)', () => {
    it('refuses a signed-out caller, an unrelated seller and a business admin', async () => {
      expect(await codeOf(make(paidOrder).service.updateShipping(ship()))).toBe(
        'UNAUTHORIZED',
      );
      expect(
        await codeOf(make(paidOrder).service.updateShipping(ship('stranger'))),
      ).toBe('FORBIDDEN');
      const business = {
        adminType: 'BUSINESS',
        role: 'SUPER_ADMIN',
        permissions: ['MANAGE_ORDERS'],
        isActive: true,
      };
      const { service, prisma } = make(paidOrder, business);
      expect(await codeOf(service.updateShipping(ship(undefined, 'a1')))).toBe(
        'FORBIDDEN',
      );
      expect(prisma.shippingStatus.update).not.toHaveBeenCalled();
    });

    it('refuses shipping an order that was never paid', async () => {
      const { service, prisma } = make({
        ...paidOrder,
        status: 'PENDING_PAYMENT',
      });
      expect(await codeOf(service.updateShipping(ship('seller')))).toBe(
        'BAD_REQUEST',
      );
      expect(prisma.shippingStatus.update).not.toHaveBeenCalled();
    });

    it("lets the order's seller move it forward", async () => {
      const { service, prisma } = make(paidOrder);
      await codeOf(service.updateShipping(ship('seller')));
      expect(prisma.shippingStatus.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { status: ShippingStage.SHIPPED, trackingInfo: null },
      });
    });
  });

  describe('tracking note (WEB-1)', () => {
    it('stores the trimmed note when the order ships', async () => {
      const { service, prisma } = make(paidOrder);
      await codeOf(
        service.updateShipping(
          ship('seller', undefined, { trackingInfo: '  Starken 123  ' }),
        ),
      );
      expect(prisma.shippingStatus.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { status: ShippingStage.SHIPPED, trackingInfo: 'Starken 123' },
      });
    });

    it('keeps the note untouched on later stages', async () => {
      const { service, prisma } = make({
        ...paidOrder,
        shippingStatus: { status: 'SHIPPED' },
      });
      await codeOf(
        service.updateShipping(
          ship('seller', undefined, {
            stage: ShippingStage.DELIVERED,
            trackingInfo: 'overwrite attempt',
          }),
        ),
      );
      expect(prisma.shippingStatus.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { status: ShippingStage.DELIVERED },
      });
    });
  });

  describe('getOrdersBySeller (WEB-1)', () => {
    it('filters on payment status and shipping stage', async () => {
      const { service, prisma } = make(null);
      await service.getOrdersBySeller({
        sellerId: 'seller',
        page: 1,
        pageSize: 10,
        status: 'PAID' as never,
        stage: ShippingStage.PREPARING,
      });
      expect(prisma.order.count).toHaveBeenCalledWith({
        where: {
          sellerId: 'seller',
          status: 'PAID',
          shippingStatus: { status: ShippingStage.PREPARING },
        },
      });
    });

    it('lists everything the seller received without filters', async () => {
      const { service, prisma } = make(null);
      await service.getOrdersBySeller({
        sellerId: 'seller',
        page: 1,
        pageSize: 10,
      });
      expect(prisma.order.count).toHaveBeenCalledWith({
        where: { sellerId: 'seller' },
      });
    });
  });

  describe('markPaid', () => {
    it('reports whether it moved the order, so a duplicate payment is caught', async () => {
      const { service, prisma } = make(paidOrder);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.markPaid(42)).resolves.toBe(false);
      await expect(service.markPaid(42)).resolves.toBe(true);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 42, status: 'PENDING_PAYMENT' },
        data: { status: 'PAID' },
      });
    });
  });

  describe('canReceivePayments (TRX-4)', () => {
    it('needs an active connection for a switched-on provider, with a token for Mercado Pago', async () => {
      const { service, prisma } = make(null);
      prisma.chileanPaymentConfig.count.mockResolvedValue(1);

      await expect(service.canReceivePayments('store')).resolves.toBe(true);
      expect(prisma.chileanPaymentConfig.count).toHaveBeenCalledWith({
        where: {
          sellerId: 'store',
          isActive: true,
          provider: { in: ['MERCADOPAGO'] },
          NOT: { provider: 'MERCADOPAGO', secretKey: null },
        },
      });
    });

    it('is false without one', async () => {
      const { service } = make(null);
      await expect(service.canReceivePayments('store')).resolves.toBe(false);
    });
  });
});
