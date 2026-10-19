import { createHmac } from 'node:crypto';
import { PaymentsService } from './payments.service.js';
import { ChileanPaymentProvider } from '../graphql/enums/index.js';
import { BadRequestError } from '../common/exceptions/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type {
  MercadoPagoAdapter,
  ProviderRegistry,
} from './providers/index.js';
import type { SettlementService } from './settlement.service.js';
import type { ServicesClient, UsersClient } from '../common/clients/index.js';
import type { ConfigService } from '@nestjs/config';
import type { CommissionService } from './commission.service.js';
import { PaymentSecrets } from './payment-secrets.js';
import type { MercadoPagoConnectService } from './mercadopago/mercadopago-connect.service.js';

const WEBHOOK_SECRET = 'mp-webhook-secret';

function make(settings: Record<string, unknown> = {}) {
  const prisma = {
    payment: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    order: { findUnique: jest.fn() },
    paymentTransaction: { create: jest.fn().mockResolvedValue({}) },
    paymentWebhook: {
      create: jest.fn().mockResolvedValue({ id: 900 }),
      update: jest.fn().mockResolvedValue({}),
    },
    chileanPaymentConfig: { findUnique: jest.fn(), findFirst: jest.fn() },
  };
  const adapter = { confirm: jest.fn(), initiate: jest.fn() };
  const providers = { for: jest.fn(() => adapter) };
  const settlement = { onCompleted: jest.fn() };
  const orders = { markCanceled: jest.fn() };
  const services = { getQuotationCharge: jest.fn() };
  const users = { activateMembership: jest.fn() };
  const commission = {
    quote: jest.fn().mockResolvedValue({
      rate: 0,
      fee: 0,
      net: 0,
      transactionFeeId: null,
    }),
  };
  const mercadoPago = {
    resolve: jest.fn(),
    identify: jest.fn(),
    lookup: jest.fn(),
  };
  const connect = { deauthorize: jest.fn() };
  const values: Record<string, unknown> = {
    'payments.enabledProviders': ['MERCADOPAGO', 'WEBPAY'],
    'mercadoPago.webhookSecret': WEBHOOK_SECRET,
    ...settings,
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
    ),
  };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    orders as unknown as OrdersService,
    providers as unknown as ProviderRegistry,
    users as unknown as UsersClient,
    config as unknown as ConfigService,
    settlement as unknown as SettlementService,
    services as unknown as ServicesClient,
    commission as unknown as CommissionService,
    mercadoPago as unknown as MercadoPagoAdapter,
    connect as unknown as MercadoPagoConnectService,
    // No key: values pass through as plain text, as in development.
    new PaymentSecrets(
      { get: () => undefined } as unknown as ConfigService,
      prisma as unknown as PrismaService,
    ),
  );
  return {
    service,
    prisma,
    adapter,
    settlement,
    services,
    orders,
    users,
    commission,
    mercadoPago,
    connect,
  };
}

/** The `x-signature` Mercado Pago would send for this notification. */
function mpSignature(dataId: string, requestId: string, ts = '1760000000') {
  const v1 = createHmac('sha256', WEBHOOK_SECRET)
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  return `ts=${ts},v1=${v1}`;
}

describe('PaymentsService', () => {
  describe('handleProviderReturn', () => {
    const payment = {
      id: 7,
      externalId: 'ekoru-42-x',
      externalToken: 'tok',
      chileanConfigId: 1,
      orderId: 42,
      paymentType: 'ORDER',
      payerId: 'buyer',
      metadata: null,
    };

    it('does not commit a payment that is already final (a reloaded return page)', async () => {
      const { service, prisma, adapter, settlement } = make();
      prisma.payment.findFirst.mockResolvedValue({
        ...payment,
        status: 'COMPLETED',
      });

      const result = await service.handleProviderReturn({
        provider: ChileanPaymentProvider.WEBPAY,
        rawPayload: { token_ws: 'tok' },
      });

      expect(result).toEqual({ paymentId: 7, status: 'COMPLETED' });
      expect(adapter.confirm).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(settlement.onCompleted).not.toHaveBeenCalled();
    });

    it('commits a processing payment and hands completion to settlement', async () => {
      const { service, prisma, adapter, settlement } = make();
      prisma.payment.findFirst.mockResolvedValue({
        ...payment,
        status: 'PROCESSING',
      });
      prisma.chileanPaymentConfig.findUnique.mockResolvedValue({
        environment: 'SANDBOX',
        merchantId: null,
        apiKey: null,
        secretKey: null,
      });
      adapter.confirm.mockResolvedValue({ status: 'COMPLETED', raw: {} });

      await service.handleProviderReturn({
        provider: ChileanPaymentProvider.WEBPAY,
        rawPayload: { token_ws: 'tok' },
      });

      expect(settlement.onCompleted).toHaveBeenCalledWith(7);
    });

    it('cancels the order when the buyer aborts', async () => {
      const { service, prisma, adapter, settlement, orders } = make();
      prisma.payment.findFirst.mockResolvedValue({
        ...payment,
        status: 'PROCESSING',
      });
      prisma.chileanPaymentConfig.findUnique.mockResolvedValue({
        environment: 'SANDBOX',
      });
      adapter.confirm.mockResolvedValue({ status: 'CANCELLED', raw: {} });

      await service.handleProviderReturn({
        provider: ChileanPaymentProvider.WEBPAY,
        rawPayload: { TBK_TOKEN: 'x', TBK_ORDEN_COMPRA: 'ekoru-42-x' },
      });

      expect(orders.markCanceled).toHaveBeenCalledWith(42);
      expect(settlement.onCompleted).not.toHaveBeenCalled();
    });
  });

  describe('createQuotationPayment (TRX-6)', () => {
    const charge = {
      id: '3',
      title: 'Reparar bicicleta',
      status: 'ACCEPTED',
      clientId: 'client',
      providerId: 'provider',
      amount: 25000,
      currency: 'CLP',
      paid: false,
      paidPaymentId: null,
    };
    const pay = (service: PaymentsService, payerId?: string) =>
      service.createQuotationPayment({
        quotationId: 3,
        returnUrl: 'https://gw/payments/return/webpay',
        provider: ChileanPaymentProvider.WEBPAY,
        payerId,
      });

    it.each([
      ['someone other than the client', { clientId: 'client' }, 'stranger'],
      ['a quotation that is not accepted', { status: 'PENDING' }, 'client'],
      ['a quotation already paid', { paid: true }, 'client'],
      ['a quotation with nothing to pay', { amount: 0 }, 'client'],
    ])('refuses %s', async (_label, over, payerId) => {
      const { service, services, prisma } = make();
      services.getQuotationCharge.mockResolvedValue({ ...charge, ...over });
      await expect(pay(service, payerId)).rejects.toBeInstanceOf(
        BadRequestError,
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('charges the amount services computed, to the provider', async () => {
      const { service, services, prisma, adapter } = make();
      services.getQuotationCharge.mockResolvedValue(charge);
      prisma.chileanPaymentConfig.findFirst.mockResolvedValue({
        id: 11,
        environment: 'SANDBOX',
      });
      prisma.payment.create.mockResolvedValue({
        id: 70,
        payerId: 'client',
        receiverId: 'provider',
      });
      adapter.initiate.mockResolvedValue({
        externalId: 'ekoru-3-x',
        externalToken: 'tok',
        redirect: { kind: 'WEBPAY_FORM', url: 'https://webpay', token: 'tok' },
      });
      prisma.payment.update.mockResolvedValue({
        id: 70,
        status: 'PROCESSING',
        payerId: 'client',
        receiverId: 'provider',
      });

      await pay(service, 'client');

      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            quotationId: 3,
            amount: 25000,
            payerId: 'client',
            receiverId: 'provider',
            paymentType: 'QUOTATION',
            chileanConfigId: 11,
          }),
        }),
      );
      expect(adapter.initiate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 25000 }),
      );
    });
  });

  describe('createPayment', () => {
    const order = {
      id: 42,
      buyerId: 'buyer',
      sellerId: 'store',
      total: 20000,
      currency: 'CLP',
      status: 'PENDING_PAYMENT',
    };
    const input = {
      orderId: 42,
      provider: ChileanPaymentProvider.MERCADOPAGO,
      returnUrl: 'https://web/api/checkout/return/mercadopago',
    };

    it("records EKORU's commission and splits it off at the provider", async () => {
      const { service, prisma, adapter, commission } = make();
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.chileanPaymentConfig.findFirst.mockResolvedValue({
        id: 5,
        environment: 'PRODUCTION',
        merchantId: '123',
        apiKey: null,
        secretKey: 'APP_USR-store',
      });
      commission.quote.mockResolvedValue({
        rate: 0.05,
        fee: 1000,
        net: 19000,
        transactionFeeId: 1,
      });
      prisma.payment.create.mockResolvedValue({
        id: 77,
        payerId: 'buyer',
        receiverId: 'store',
      });
      adapter.initiate.mockResolvedValue({
        externalId: 'pref-1',
        externalToken: null,
        redirect: { kind: 'EXTERNAL', url: 'https://mp/checkout' },
      });
      prisma.payment.update.mockResolvedValue({
        id: 77,
        status: 'PROCESSING',
        payerId: 'buyer',
        receiverId: 'store',
      });

      await service.createPayment({ input, payerId: 'buyer' });

      expect(commission.quote).toHaveBeenCalledWith({
        sellerId: 'store',
        amount: 20000,
      });
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount: 20000,
            fees: 1000,
            netAmount: 19000,
            feePercentage: 0.05,
            receiverId: 'store',
          }),
        }),
      );
      expect(adapter.initiate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 20000, platformFee: 1000 }),
      );
    });

    it('refuses a provider that is switched off', async () => {
      const { service, prisma } = make({
        'payments.enabledProviders': ['MERCADOPAGO'],
      });
      await expect(
        service.createPayment({
          input: { ...input, provider: ChileanPaymentProvider.WEBPAY },
          payerId: 'buyer',
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('Mercado Pago return', () => {
    const payment = {
      id: 77,
      amount: 20000,
      externalId: 'pref-1',
      externalToken: null,
      chileanConfigId: 5,
      orderId: 42,
      paymentType: 'ORDER',
      payerId: 'buyer',
      metadata: null,
    };

    it('finds the payment by our reference and stores the Mercado Pago id', async () => {
      const { service, prisma, adapter, settlement } = make();
      prisma.payment.findFirst.mockResolvedValue({
        ...payment,
        status: 'PROCESSING',
      });
      prisma.chileanPaymentConfig.findUnique.mockResolvedValue({
        environment: 'PRODUCTION',
        merchantId: '123',
        apiKey: null,
        secretKey: 'APP_USR-store',
      });
      adapter.confirm.mockResolvedValue({
        status: 'COMPLETED',
        raw: {},
        providerPaymentId: '555',
      });

      const result = await service.handleProviderReturn({
        provider: ChileanPaymentProvider.MERCADOPAGO,
        rawPayload: {
          payment_id: '555',
          status: 'approved',
          external_reference: 'ekoru-pay-77',
          preference_id: 'pref-1',
        },
      });

      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 77, paymentProvider: 'MERCADOPAGO' },
        }),
      );
      expect(adapter.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: 77, amount: 20000 }),
      );
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'COMPLETED',
            externalToken: '555',
          }),
        }),
      );
      expect(settlement.onCompleted).toHaveBeenCalledWith(77);
      expect(result).toEqual({ paymentId: 77, status: 'COMPLETED' });
    });

    it('leaves an expired payment expired when the buyer did not pay', async () => {
      const { service, prisma, adapter } = make();
      prisma.payment.findFirst.mockResolvedValue({
        ...payment,
        status: 'EXPIRED',
      });
      prisma.chileanPaymentConfig.findUnique.mockResolvedValue({
        environment: 'PRODUCTION',
      });
      adapter.confirm.mockResolvedValue({ status: 'PROCESSING', raw: {} });

      const result = await service.handleProviderReturn({
        provider: ChileanPaymentProvider.MERCADOPAGO,
        rawPayload: { external_reference: 'ekoru-pay-77', status: 'null' },
      });

      expect(result.status).toBe('EXPIRED');
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });
  });

  describe('Mercado Pago webhook (TRX-16)', () => {
    const payment = {
      id: 77,
      amount: 20000,
      externalId: 'pref-1',
      externalToken: null,
      chileanConfigId: 5,
      orderId: 42,
      paymentType: 'ORDER',
      payerId: 'buyer',
      metadata: null,
      status: 'PROCESSING',
    };
    const storeConfig = {
      id: 5,
      environment: 'PRODUCTION',
      merchantId: '123',
      apiKey: null,
      secretKey: 'APP_USR-store',
    };
    const body = {
      type: 'payment',
      action: 'payment.updated',
      user_id: 123,
      data: { id: '555' },
    };
    const deliver = (
      service: PaymentsService,
      signature = mpSignature('555', 'req-1'),
      payload: Record<string, unknown> = body,
      query: Record<string, unknown> = {
        'data.id': '555',
        type: 'payment',
        ekoru_payment: '77',
      },
    ) =>
      service.handleProviderWebhook({
        provider: ChileanPaymentProvider.MERCADOPAGO,
        eventType: 'payment',
        rawPayload: payload,
        signature,
        requestId: 'req-1',
        query,
      });

    it('records and refuses a notification whose signature does not verify', async () => {
      const { service, prisma, mercadoPago, settlement } = make();
      prisma.payment.findFirst.mockResolvedValue(payment);

      await expect(
        deliver(service, mpSignature('999', 'req-1')),
      ).rejects.toBeInstanceOf(BadRequestError);

      expect(prisma.paymentWebhook.create).toHaveBeenCalled();
      expect(mercadoPago.resolve).not.toHaveBeenCalled();
      expect(settlement.onCompleted).not.toHaveBeenCalled();
    });

    it('refuses every notification while the secret is not configured', async () => {
      const { service, mercadoPago } = make({
        'mercadoPago.webhookSecret': undefined,
      });
      await expect(deliver(service)).rejects.toBeInstanceOf(BadRequestError);
      expect(mercadoPago.resolve).not.toHaveBeenCalled();
    });

    it("reads the payment back with the store's token and settles it", async () => {
      const { service, prisma, mercadoPago, settlement } = make();
      prisma.payment.findFirst.mockResolvedValue(payment);
      prisma.chileanPaymentConfig.findUnique.mockResolvedValue(storeConfig);
      mercadoPago.resolve.mockResolvedValue({
        status: 'COMPLETED',
        raw: {},
        providerPaymentId: '555',
      });

      const result = await deliver(service);

      expect(mercadoPago.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: 77,
          amount: 20000,
          providerPaymentId: '555',
          config: expect.objectContaining({ secretKey: 'APP_USR-store' }),
        }),
      );
      expect(settlement.onCompleted).toHaveBeenCalledWith(77);
      expect(result).toEqual({ paymentId: 77, status: 'COMPLETED' });
      expect(prisma.paymentWebhook.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ processed: true, paymentId: 77 }),
        }),
      );
    });

    it('without a hint, finds the store by its account and the payment by its reference', async () => {
      const { service, prisma, mercadoPago } = make();
      prisma.chileanPaymentConfig.findFirst.mockResolvedValue(storeConfig);
      mercadoPago.identify.mockResolvedValue(77);
      prisma.payment.findFirst.mockResolvedValue(payment);
      mercadoPago.resolve.mockResolvedValue({ status: 'FAILED', raw: {} });

      await deliver(service, undefined, body, {
        'data.id': '555',
        type: 'payment',
      });

      expect(prisma.chileanPaymentConfig.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { provider: 'MERCADOPAGO', merchantId: '123' },
        }),
      );
      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 77,
            paymentProvider: 'MERCADOPAGO',
            chileanConfigId: 5,
          },
        }),
      );
    });

    it('keeps the order open after a rejected attempt, so a retry can still pay it', async () => {
      const { service, prisma, mercadoPago, orders, settlement } = make();
      prisma.payment.findFirst.mockResolvedValueOnce(payment);
      prisma.chileanPaymentConfig.findUnique.mockResolvedValue(storeConfig);
      mercadoPago.resolve.mockResolvedValueOnce({
        status: 'FAILED',
        raw: {},
        providerPaymentId: '554',
      });

      await deliver(service, mpSignature('554', 'req-1'), body, {
        'data.id': '554',
        type: 'payment',
        ekoru_payment: '77',
      });

      expect(orders.markCanceled).not.toHaveBeenCalled();

      // The buyer retries on the same checkout and the card goes through.
      prisma.payment.findFirst.mockResolvedValueOnce({
        ...payment,
        status: 'FAILED',
      });
      mercadoPago.resolve.mockResolvedValueOnce({
        status: 'COMPLETED',
        raw: {},
        providerPaymentId: '555',
      });

      await deliver(service);

      expect(settlement.onCompleted).toHaveBeenCalledWith(77);
    });

    it('settles a charge that lands on an expired payment, so settlement can refund it', async () => {
      const { service, prisma, mercadoPago, settlement } = make();
      prisma.payment.findFirst.mockResolvedValue({
        ...payment,
        status: 'EXPIRED',
      });
      prisma.chileanPaymentConfig.findUnique.mockResolvedValue(storeConfig);
      mercadoPago.resolve.mockResolvedValue({ status: 'COMPLETED', raw: {} });

      await deliver(service);

      expect(settlement.onCompleted).toHaveBeenCalledWith(77);
    });

    it('never touches a completed payment again', async () => {
      const { service, prisma, mercadoPago } = make();
      prisma.payment.findFirst.mockResolvedValue({
        ...payment,
        status: 'COMPLETED',
      });
      prisma.chileanPaymentConfig.findUnique.mockResolvedValue(storeConfig);

      await deliver(service);

      expect(mercadoPago.resolve).not.toHaveBeenCalled();
    });

    it('pauses the store connection when it unlinks EKORU', async () => {
      const { service, connect } = make();
      const payload = {
        type: 'mp-connect',
        action: 'application.deauthorized',
        user_id: 123,
        data: { id: 'abc' },
      };

      await deliver(service, mpSignature('abc', 'req-1'), payload, {
        'data.id': 'abc',
        type: 'mp-connect',
      });

      expect(connect.deauthorize).toHaveBeenCalledWith('123');
    });
  });

  describe('reconcileStale', () => {
    it('settles stale Mercado Pago payments that were paid, and leaves the rest to expire', async () => {
      const { service, prisma, mercadoPago, settlement } = make();
      const base = {
        amount: 20000,
        externalId: 'pref',
        externalToken: null,
        chileanConfigId: 5,
        paymentType: 'ORDER',
        payerId: 'buyer',
        metadata: null,
        status: 'PROCESSING',
        chileanPaymentConfig: {
          environment: 'PRODUCTION',
          merchantId: '123',
          apiKey: null,
          secretKey: 'APP_USR-store',
        },
      };
      prisma.payment.findMany.mockResolvedValue([
        { ...base, id: 1, orderId: 10 },
        { ...base, id: 2, orderId: 20 },
      ]);
      mercadoPago.lookup
        .mockResolvedValueOnce({ status: 'COMPLETED', raw: {} })
        .mockResolvedValueOnce({ status: 'PROCESSING', raw: {} });

      const settled = await service.reconcileStale(60);

      expect(settled).toBe(1);
      expect(settlement.onCompleted).toHaveBeenCalledWith(1);
      expect(settlement.onCompleted).not.toHaveBeenCalledWith(2);
    });
  });
});
