import { SettlementService } from './settlement.service.js';
import { PAYMENT_JOBS } from './payment-queue.js';
import { BadRequestError } from '../common/exceptions/index.js';
import { SubgraphError } from '../common/clients/subgraph-call.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { ProviderRegistry } from './providers/index.js';
import type {
  ServicesClient,
  StoresClient,
  UsersClient,
} from '../common/clients/index.js';
import type { Queue } from 'bullmq';
import type { ConfigService } from '@nestjs/config';

/** A Prisma stub with just what SettlementService touches. */
function makePrisma() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    payment: { findUnique: jest.fn() },
    paymentRefund: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      create: jest.fn((args: { data: { amount: number } }) =>
        Promise.resolve({ id: 900, ...args.data, status: 'PENDING' }),
      ),
    },
    paymentTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    payment: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    order: { findMany: jest.fn().mockResolvedValue([]) },
    orderItem: { findMany: jest.fn().mockResolvedValue([]) },
    paymentTransaction: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    paymentRefund: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
    },
    chileanPaymentConfig: {
      findUnique: jest.fn().mockResolvedValue({
        environment: 'SANDBOX',
        merchantId: null,
        apiKey: null,
        secretKey: null,
      }),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, tx };
}

function make() {
  const { prisma, tx } = makePrisma();
  const orders = {
    markPaid: jest.fn().mockResolvedValue(true),
    markCanceled: jest.fn().mockResolvedValue(undefined),
    markRefunded: jest.fn().mockResolvedValue(undefined),
  };
  const adapter = { refund: jest.fn() };
  const providers = { for: jest.fn(() => adapter) };
  const stores = { adjustStock: jest.fn() };
  const services = { markQuotationPaid: jest.fn() };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const users = { notifyTransaction: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn().mockReturnValue('https://ekoru.cl') };
  const service = new SettlementService(
    prisma as unknown as PrismaService,
    orders as unknown as OrdersService,
    providers as unknown as ProviderRegistry,
    stores as unknown as StoresClient,
    services as unknown as ServicesClient,
    queue as unknown as Queue,
    users as unknown as UsersClient,
    config as unknown as ConfigService,
  );
  return {
    service,
    prisma,
    tx,
    orders,
    adapter,
    stores,
    services,
    queue,
    users,
  };
}

const jobNames = (queue: { add: jest.Mock }) =>
  queue.add.mock.calls.map((c) => c[0] as string);

describe('SettlementService', () => {
  describe('onCompleted', () => {
    it('marks the order paid and queues the stock movement', async () => {
      const { service, prisma, orders, queue } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 7,
        amount: 10000,
        orderId: 42,
        quotationId: null,
        paymentType: 'ORDER',
      });

      await service.onCompleted(7);

      expect(orders.markPaid).toHaveBeenCalledWith(42);
      expect(queue.add).toHaveBeenCalledWith(
        PAYMENT_JOBS.stock,
        { kind: 'SALE', orderId: 42, paymentId: 7 },
        expect.objectContaining({ jobId: 'stock-sale-42' }),
      );
    });

    it('refunds a second payment for an order that is already paid', async () => {
      const { service, prisma, orders, tx, queue } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 8,
        amount: 10000,
        orderId: 42,
        quotationId: null,
        paymentType: 'ORDER',
      });
      orders.markPaid.mockResolvedValue(false);
      tx.payment.findUnique.mockResolvedValue({
        id: 8,
        amount: 10000,
        status: 'COMPLETED',
      });

      await service.onCompleted(8);

      expect(tx.paymentRefund.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paymentId: 8, amount: 10000 }),
        }),
      );
      expect(jobNames(queue)).toEqual([PAYMENT_JOBS.refund]);
    });

    it('queues the quotation stamp for a quotation payment', async () => {
      const { service, prisma, queue } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 9,
        amount: 50000,
        orderId: null,
        quotationId: 3,
        paymentType: 'QUOTATION',
      });

      await service.onCompleted(9);

      expect(jobNames(queue)).toEqual([PAYMENT_JOBS.quotation]);
    });
  });

  describe('settleQuotation (TRX-6)', () => {
    it('stamps the quotation paid in services', async () => {
      const { service, prisma, services } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 9,
        amount: 50000,
        quotationId: 3,
        status: 'COMPLETED',
      });
      await service.settleQuotation(9);
      expect(services.markQuotationPaid).toHaveBeenCalledWith({
        quotationId: 3,
        paymentId: 9,
      });
    });

    it('refunds when services refuses (already paid by another payment)', async () => {
      const { service, prisma, services, tx } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 9,
        amount: 50000,
        quotationId: 3,
        status: 'COMPLETED',
      });
      services.markQuotationPaid.mockRejectedValue(
        new SubgraphError('ya fue pagada', 'BAD_REQUEST'),
      );
      tx.payment.findUnique.mockResolvedValue({
        id: 9,
        amount: 50000,
        status: 'COMPLETED',
      });

      await service.settleQuotation(9);

      expect(tx.paymentRefund.create).toHaveBeenCalled();
    });

    const charge = {
      id: '3',
      title: 'Reparación de bicicleta',
      status: 'ACCEPTED',
      clientId: 'client',
      providerId: 'provider',
      amount: 50000,
      currency: 'CLP',
      paid: true,
      paidPaymentId: 9,
    };

    it('emails the client and the provider once the quote is paid (WEB-4)', async () => {
      const { service, prisma, services, users } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 9,
        amount: 50000,
        quotationId: 3,
        status: 'COMPLETED',
      });
      services.markQuotationPaid.mockResolvedValue(charge);

      await service.settleQuotation(9);

      expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          paymentId: 9,
          action: 'QUOTATION_PAID_NOTICE',
        }),
      });
      const calls = users.notifyTransaction.mock.calls as [
        string,
        { type: string; role: string; detailUrl: string },
      ][];
      expect(calls.map(([id, n]) => [id, n.role, n.type])).toEqual([
        ['client', 'BUYER', 'PAYMENT_RECEIVED'],
        ['provider', 'SELLER', 'PAYMENT_RECEIVED'],
      ]);
      expect(calls[0][1].detailUrl).toBe('https://ekoru.cl/profile/quotes');
    });

    it('stays quiet when a retried job already sent the notice', async () => {
      const { service, prisma, services, users } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 9,
        amount: 50000,
        quotationId: 3,
        status: 'COMPLETED',
      });
      services.markQuotationPaid.mockResolvedValue(charge);
      prisma.paymentTransaction.findFirst.mockResolvedValue({ id: 1 });

      await service.settleQuotation(9);

      expect(users.notifyTransaction).not.toHaveBeenCalled();
    });

    it('does not fail the job when the notice cannot be sent', async () => {
      const { service, prisma, services, users } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 9,
        amount: 50000,
        quotationId: 3,
        status: 'COMPLETED',
      });
      services.markQuotationPaid.mockResolvedValue(charge);
      users.notifyTransaction.mockRejectedValue(new Error('users down'));

      await expect(service.settleQuotation(9)).resolves.toBeUndefined();
    });

    it('lets other failures throw, so the job retries', async () => {
      const { service, prisma, services } = make();
      prisma.payment.findUnique.mockResolvedValue({
        id: 9,
        amount: 50000,
        quotationId: 3,
        status: 'COMPLETED',
      });
      services.markQuotationPaid.mockRejectedValue(new Error('services down'));
      await expect(service.settleQuotation(9)).rejects.toThrow('services down');
    });
  });

  describe('takeStock (TRX-3)', () => {
    const lines = [
      { storeProductId: 1, quantity: 2, price: 5000 },
      { storeProductId: 2, quantity: 1, price: 8000 },
    ];

    it('takes the units and records what stores did', async () => {
      const { service, prisma, stores, tx } = make();
      prisma.orderItem.findMany.mockResolvedValue(lines);
      stores.adjustStock.mockResolvedValue({
        reference: 'order:42:sale',
        alreadyApplied: false,
        complete: true,
        items: [
          { storeProductId: 1, requested: 2, applied: 2 },
          { storeProductId: 2, requested: 1, applied: 1 },
        ],
      });

      await service.takeStock({ orderId: 42, paymentId: 7 });

      expect(stores.adjustStock).toHaveBeenCalledWith({
        reference: 'order:42:sale',
        kind: 'SALE',
        items: [
          { storeProductId: 1, quantity: 2 },
          { storeProductId: 2, quantity: 1 },
        ],
      });
      expect(prisma.paymentTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'STOCK', status: 'COMPLETED' }),
      });
      expect(tx.paymentRefund.create).not.toHaveBeenCalled();
    });

    it('refunds the oversold units at their order price', async () => {
      const { service, prisma, stores, tx } = make();
      prisma.orderItem.findMany.mockResolvedValue(lines);
      prisma.payment.findUnique.mockResolvedValue({ amount: 21990 });
      stores.adjustStock.mockResolvedValue({
        reference: 'order:42:sale',
        alreadyApplied: false,
        complete: false,
        items: [
          { storeProductId: 1, requested: 2, applied: 1 },
          { storeProductId: 2, requested: 1, applied: 1 },
        ],
      });
      tx.payment.findUnique.mockResolvedValue({
        id: 7,
        amount: 21990,
        status: 'COMPLETED',
      });

      await service.takeStock({ orderId: 42, paymentId: 7 });

      expect(tx.paymentRefund.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: 5000 }),
        }),
      );
    });

    it('refunds the whole payment (shipping included) when nothing was left', async () => {
      const { service, prisma, stores, tx } = make();
      prisma.orderItem.findMany.mockResolvedValue(lines);
      prisma.payment.findUnique.mockResolvedValue({ amount: 21990 });
      stores.adjustStock.mockResolvedValue({
        reference: 'order:42:sale',
        alreadyApplied: false,
        complete: false,
        items: [
          { storeProductId: 1, requested: 2, applied: 0 },
          { storeProductId: 2, requested: 1, applied: 0 },
        ],
      });
      tx.payment.findUnique.mockResolvedValue({
        id: 7,
        amount: 21990,
        status: 'COMPLETED',
      });

      await service.takeStock({ orderId: 42, paymentId: 7 });

      expect(tx.paymentRefund.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: 21990 }),
        }),
      );
    });

    it('does nothing again once the movement is recorded', async () => {
      const { service, prisma, stores } = make();
      prisma.paymentTransaction.findFirst.mockResolvedValue({
        metadata: { items: [] },
      });
      await service.takeStock({ orderId: 42, paymentId: 7 });
      expect(stores.adjustStock).not.toHaveBeenCalled();
    });

    it('puts back only what the sale took', async () => {
      const { service, prisma, stores } = make();
      prisma.paymentTransaction.findFirst.mockResolvedValue({
        metadata: {
          items: [
            { storeProductId: 1, requested: 2, applied: 1 },
            { storeProductId: 2, requested: 1, applied: 0 },
          ],
        },
      });
      await service.restock({ orderId: 42, paymentId: 7 });
      expect(stores.adjustStock).toHaveBeenCalledWith({
        reference: 'order:42:restock',
        kind: 'RESTOCK',
        items: [{ storeProductId: 1, quantity: 1 }],
      });
    });
  });

  describe('requestRefund (TRX-2)', () => {
    it('refuses more than what is left to give back', async () => {
      const { service, tx } = make();
      tx.payment.findUnique.mockResolvedValue({
        id: 7,
        amount: 10000,
        status: 'PARTIALLY_REFUNDED',
      });
      tx.paymentRefund.aggregate.mockResolvedValue({ _sum: { amount: 8000 } });

      await expect(
        service.requestRefund({ paymentId: 7, amount: 3000, reason: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestError);
      expect(tx.paymentRefund.create).not.toHaveBeenCalled();
    });

    it('refuses a payment that was never charged', async () => {
      const { service, tx } = make();
      tx.payment.findUnique.mockResolvedValue({
        id: 7,
        amount: 10000,
        status: 'PROCESSING',
      });
      await expect(
        service.requestRefund({ paymentId: 7, amount: 1000, reason: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it('locks the payment row, records the request and queues the provider call', async () => {
      const { service, tx, queue } = make();
      tx.payment.findUnique.mockResolvedValue({
        id: 7,
        amount: 10000,
        status: 'COMPLETED',
      });

      await service.requestRefund({
        paymentId: 7,
        amount: 2000,
        reason: 'Producto dañado',
        requestedBy: 'admin-1',
      });

      expect(String(tx.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE');
      expect(tx.paymentTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ createdBy: 'admin-1' }),
      });
      expect(queue.add).toHaveBeenCalledWith(
        PAYMENT_JOBS.refund,
        { refundId: 900 },
        expect.objectContaining({ jobId: 'refund-900' }),
      );
    });
  });

  describe('executeRefund (TRX-2)', () => {
    const pending = {
      id: 900,
      amount: 10000,
      status: 'PENDING',
      payment: {
        id: 7,
        amount: 10000,
        externalId: 'ekoru-42-x',
        externalToken: 'tok',
        paymentProvider: 'WEBPAY',
        chileanConfigId: 1,
        orderId: 42,
      },
    };

    it('marks everything refunded only after the provider approves, and restocks', async () => {
      const { service, prisma, adapter, orders, queue } = make();
      prisma.paymentRefund.findUnique.mockResolvedValue(pending);
      adapter.refund.mockResolvedValue({
        ok: true,
        externalRefundId: 'AUTH1',
        raw: { type: 'NULLIFIED', response_code: 0 },
      });
      prisma.paymentRefund.aggregate.mockResolvedValue({
        _sum: { amount: 10000 },
      });

      await service.executeRefund(900);

      expect(adapter.refund).toHaveBeenCalledWith(
        expect.objectContaining({ externalToken: 'tok', amount: 10000 }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: expect.objectContaining({ status: 'REFUNDED' }),
      });
      expect(orders.markRefunded).toHaveBeenCalledWith({
        orderId: 42,
        full: true,
        amount: 10000,
      });
      expect(queue.add).toHaveBeenCalledWith(
        PAYMENT_JOBS.stock,
        { kind: 'RESTOCK', orderId: 42, paymentId: 7 },
        expect.anything(),
      );
    });

    it('leaves a partial refund PARTIALLY_REFUNDED and stock alone', async () => {
      const { service, prisma, adapter, orders, queue } = make();
      prisma.paymentRefund.findUnique.mockResolvedValue({
        ...pending,
        amount: 4000,
      });
      adapter.refund.mockResolvedValue({
        ok: true,
        externalRefundId: 'A',
        raw: {},
      });
      prisma.paymentRefund.aggregate.mockResolvedValue({
        _sum: { amount: 4000 },
      });

      await service.executeRefund(900);

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: expect.objectContaining({ status: 'PARTIALLY_REFUNDED' }),
      });
      expect(orders.markRefunded).toHaveBeenCalledWith(
        expect.objectContaining({ full: false }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('marks the refund FAILED when the provider refuses, and touches nothing else', async () => {
      const { service, prisma, adapter, orders } = make();
      prisma.paymentRefund.findUnique.mockResolvedValue(pending);
      adapter.refund.mockResolvedValue({
        ok: false,
        externalRefundId: null,
        raw: { type: 'NULLIFIED', response_code: -1 },
      });

      await service.executeRefund(900);

      expect(prisma.paymentRefund.update).toHaveBeenLastCalledWith({
        where: { id: 900 },
        data: { status: 'FAILED' },
      });
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(orders.markRefunded).not.toHaveBeenCalled();
    });

    it('lets a network error throw, so the queue retries', async () => {
      const { service, prisma, adapter } = make();
      prisma.paymentRefund.findUnique.mockResolvedValue(pending);
      adapter.refund.mockRejectedValue(new Error('timeout'));
      await expect(service.executeRefund(900)).rejects.toThrow('timeout');
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('skips a refund that already finished', async () => {
      const { service, prisma, adapter } = make();
      prisma.paymentRefund.findUnique.mockResolvedValue({
        ...pending,
        status: 'COMPLETED',
      });
      await service.executeRefund(900);
      expect(adapter.refund).not.toHaveBeenCalled();
    });
  });

  describe('expireStale (TRX-9)', () => {
    it('expires old pending payments and cancels old unpaid orders', async () => {
      const { service, prisma, orders } = make();
      prisma.payment.updateMany.mockResolvedValue({ count: 2 });
      prisma.order.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

      const result = await service.expireStale(60);

      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: {
          status: { in: ['PENDING', 'PROCESSING'] },
          createdAt: { lt: expect.any(Date) },
        },
        data: expect.objectContaining({ status: 'EXPIRED' }),
      });
      expect(orders.markCanceled).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ payments: 2, orders: 2 });
    });
  });
});
