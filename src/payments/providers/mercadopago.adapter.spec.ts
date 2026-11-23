import type { ConfigService } from '@nestjs/config';
import {
  MercadoPagoAdapter,
  isMercadoPagoOrderId,
  mapMercadoPagoOrderStatus,
  mapMercadoPagoStatus,
  mercadoPagoAmount,
  paymentIdFromReference,
} from './mercadopago.adapter.js';
import {
  MercadoPagoApiError,
  type MercadoPagoApi,
} from '../mercadopago/mercadopago.api.js';

const config = {
  environment: 'PRODUCTION' as const,
  merchantId: '123',
  apiKey: null,
  secretKey: 'APP_USR-store',
};

const ORDER_ID = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';

/** A paid Checkout Pro order for payment 77, as `/v1/orders/{id}` answers. */
const paidOrder = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  status: 'processed',
  status_detail: 'accredited',
  external_reference: 'ekoru-pay-77',
  total_amount: '20000',
  total_paid_amount: '20000',
  marketplace_fee: '1000',
  transactions: {
    payments: [
      {
        id: 'PAY01JQ4S4KY8HWQ6NA5PXB65B3D4',
        status: 'processed',
        status_detail: 'accredited',
        amount: '20000',
        paid_amount: '20000',
      },
    ],
  },
  ...overrides,
});

function make(overrides: Record<string, unknown> = {}) {
  const api = {
    createPreference: jest.fn().mockResolvedValue({
      id: 'pref-1',
      init_point:
        'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=pref-1',
    }),
    getPayment: jest.fn(),
    findPaymentByReference: jest.fn(),
    refund: jest.fn(),
    createOrder: jest.fn().mockResolvedValue({
      id: ORDER_ID,
      status: 'created',
      checkout_url: `https://www.mercadopago.cl/checkout/v1/redirect?order_id=${ORDER_ID}`,
    }),
    getOrder: jest.fn(),
    refundOrder: jest.fn(),
  };
  const values: Record<string, unknown> = {
    gatewayBaseUrl: 'https://api.ekoru.cl',
    'payments.expireAfterMinutes': 60,
    ...overrides,
  };
  const settings = {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  };
  return {
    adapter: new MercadoPagoAdapter(
      settings as unknown as ConfigService,
      api as unknown as MercadoPagoApi,
    ),
    api,
  };
}

describe('MercadoPagoAdapter', () => {
  describe('initiate', () => {
    it("creates the preference with the store's token and EKORU's fee", async () => {
      const { adapter, api } = make();

      const result = await adapter.initiate({
        paymentId: 77,
        orderId: 42,
        amount: 20000,
        currency: 'CLP',
        description: 'Orden Ekoru #42',
        returnUrl: 'https://ekoru.cl/api/checkout/return/mercadopago',
        platformFee: 1000,
        config,
      });

      const call = api.createPreference.mock.calls[0][0];
      expect(call.accessToken).toBe('APP_USR-store');
      expect(call.idempotencyKey).toBe('ekoru-pref-77');
      expect(call.body).toEqual(
        expect.objectContaining({
          external_reference: 'ekoru-pay-77',
          marketplace_fee: 1000,
          binary_mode: true,
          expires: true,
          auto_return: 'approved',
          notification_url:
            'https://api.ekoru.cl/payments/webhook/mercadopago?source_news=webhooks&ekoru_payment=77',
        }),
      );
      expect(call.body.items[0]).toEqual(
        expect.objectContaining({ unit_price: 20000, currency_id: 'CLP' }),
      );
      expect(result).toEqual({
        externalId: 'pref-1',
        externalToken: null,
        redirect: {
          kind: 'EXTERNAL',
          url: 'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=pref-1',
        },
      });
    });

    it('sends no fee for a payment to EKORU itself', async () => {
      const { adapter, api } = make();
      await adapter.initiate({
        paymentId: 78,
        orderId: 0,
        amount: 9990,
        currency: 'CLP',
        description: 'EKORU suscripción',
        returnUrl: 'https://ekoru.cl/api/checkout/return/mercadopago',
        config,
      });
      expect(api.createPreference.mock.calls[0][0].body).not.toHaveProperty(
        'marketplace_fee',
      );
    });

    it('refuses a store that is not connected', async () => {
      const { adapter } = make();
      await expect(
        adapter.initiate({
          paymentId: 1,
          orderId: 1,
          amount: 1000,
          currency: 'CLP',
          description: 'x',
          returnUrl: 'https://x',
          config: { ...config, secretKey: null },
        }),
      ).rejects.toThrow('no está conectada');
    });
  });

  describe('confirm', () => {
    const args = {
      paymentId: 77,
      amount: 20000,
      externalId: 'pref-1',
      externalToken: null,
      config,
    };

    it('reads the named payment back and completes an approved one', async () => {
      const { adapter, api } = make();
      api.getPayment.mockResolvedValue({
        id: 555,
        status: 'approved',
        external_reference: 'ekoru-pay-77',
        transaction_amount: 20000,
      });

      const result = await adapter.confirm({
        ...args,
        rawPayload: { payment_id: '555', status: 'approved' },
      });

      expect(api.getPayment).toHaveBeenCalledWith({
        accessToken: 'APP_USR-store',
        paymentId: '555',
      });
      expect(result.status).toBe('COMPLETED');
      expect(result.providerPaymentId).toBe('555');
    });

    it('ignores what the query claims and trusts the API', async () => {
      const { adapter, api } = make();
      api.getPayment.mockResolvedValue({
        id: 555,
        status: 'rejected',
        external_reference: 'ekoru-pay-77',
        transaction_amount: 20000,
      });
      const result = await adapter.confirm({
        ...args,
        rawPayload: { payment_id: '555', status: 'approved' },
      });
      expect(result.status).toBe('FAILED');
    });

    it("refuses a payment that carries another payment's reference", async () => {
      const { adapter, api } = make();
      api.getPayment.mockResolvedValue({
        id: 556,
        status: 'approved',
        external_reference: 'ekoru-pay-12',
        transaction_amount: 20000,
      });
      const result = await adapter.confirm({
        ...args,
        rawPayload: { payment_id: '556' },
      });
      expect(result.status).toBe('PROCESSING');
    });

    it('fails an approved payment for the wrong amount', async () => {
      const { adapter, api } = make();
      api.getPayment.mockResolvedValue({
        id: 555,
        status: 'approved',
        external_reference: 'ekoru-pay-77',
        transaction_amount: 100,
      });
      const result = await adapter.confirm({
        ...args,
        rawPayload: { payment_id: '555' },
      });
      expect(result.status).toBe('FAILED');
    });

    it('looks the payment up by reference when the buyer came back without one', async () => {
      const { adapter, api } = make();
      api.findPaymentByReference.mockResolvedValue(null);
      const result = await adapter.confirm({
        ...args,
        rawPayload: { payment_id: 'null', status: 'null' },
      });
      expect(api.getPayment).not.toHaveBeenCalled();
      expect(api.findPaymentByReference).toHaveBeenCalledWith({
        accessToken: 'APP_USR-store',
        externalReference: 'ekoru-pay-77',
      });
      expect(result.status).toBe('PROCESSING');
    });
  });

  describe('refund', () => {
    it("refunds the Mercado Pago payment with the store's token, idempotently", async () => {
      const { adapter, api } = make();
      api.refund.mockResolvedValue({
        id: 9,
        payment_id: 555,
        amount: 5000,
        status: 'approved',
      });
      const result = await adapter.refund({
        paymentId: 77,
        refundId: 3,
        externalId: 'pref-1',
        externalToken: '555',
        amount: 5000,
        config,
      });
      expect(api.refund).toHaveBeenCalledWith({
        accessToken: 'APP_USR-store',
        paymentId: '555',
        amount: 5000,
        idempotencyKey: 'ekoru-refund-3',
      });
      expect(result).toEqual(
        expect.objectContaining({ ok: true, externalRefundId: '9' }),
      );
    });

    it('cannot refund before the charge is known', async () => {
      const { adapter, api } = make();
      const result = await adapter.refund({
        paymentId: 77,
        externalId: 'pref-1',
        externalToken: null,
        amount: 5000,
        config,
      });
      expect(result.ok).toBe(false);
      expect(api.refund).not.toHaveBeenCalled();
    });
  });
});

describe('MercadoPagoAdapter on the Orders API (TRX-24)', () => {
  const orders = { 'mercadoPago.checkoutApi': 'orders' };
  const checkout = {
    paymentId: 77,
    orderId: 42,
    amount: 20000,
    currency: 'CLP',
    description: 'Orden Ekoru #42',
    returnUrl: 'https://api.ekoru.cl/payments/return/mercadopago',
    platformFee: 1000,
    config,
  };

  describe('initiate', () => {
    it("creates a Checkout Pro order with the store's token and EKORU's fee", async () => {
      const { adapter, api } = make(orders);

      const result = await adapter.initiate(checkout);

      expect(api.createPreference).not.toHaveBeenCalled();
      const call = api.createOrder.mock.calls[0][0];
      expect(call.accessToken).toBe('APP_USR-store');
      expect(call.idempotencyKey).toBe('ekoru-order-77');
      const returnUrl =
        'https://api.ekoru.cl/payments/return/mercadopago?ekoru_payment=77';
      expect(call.body).toEqual({
        type: 'online',
        processing_mode: 'manual',
        capture_mode: 'automatic',
        external_reference: 'ekoru-pay-77',
        total_amount: '20000',
        description: 'Orden Ekoru #42',
        marketplace_fee: '1000',
        expiration_time: 'PT55M',
        items: [
          {
            title: 'Orden Ekoru #42',
            unit_price: '20000',
            quantity: 1,
            external_code: '42',
          },
        ],
        config: {
          online: {
            success_url: returnUrl,
            failure_url: returnUrl,
            pending_url: returnUrl,
            auto_return: 'approved',
          },
        },
      });
      expect(result).toEqual({
        externalId: ORDER_ID,
        externalToken: null,
        redirect: {
          kind: 'EXTERNAL',
          url: `https://www.mercadopago.cl/checkout/v1/redirect?order_id=${ORDER_ID}`,
        },
      });
    });

    it('sends no fee for a payment to EKORU itself', async () => {
      const { adapter, api } = make(orders);
      await adapter.initiate({ ...checkout, platformFee: undefined });
      expect(api.createOrder.mock.calls[0][0].body).not.toHaveProperty(
        'marketplace_fee',
      );
    });

    it('keeps a query the return URL already has', async () => {
      const { adapter, api } = make(orders);
      await adapter.initiate({
        ...checkout,
        returnUrl: 'https://api.ekoru.cl/payments/return/mercadopago?app=1',
      });
      expect(
        api.createOrder.mock.calls[0][0].body.config.online.success_url,
      ).toBe(
        'https://api.ekoru.cl/payments/return/mercadopago?app=1&ekoru_payment=77',
      );
    });

    it('refuses an answer without a checkout link', async () => {
      const { adapter, api } = make(orders);
      api.createOrder.mockResolvedValue({ id: ORDER_ID, status: 'created' });
      await expect(adapter.initiate(checkout)).rejects.toThrow(
        'no devolvió el enlace de pago',
      );
    });
  });

  describe('reading an order back', () => {
    const args = {
      paymentId: 77,
      amount: 20000,
      externalId: ORDER_ID,
      externalToken: null,
      config,
    };

    it('reads the stored order, whatever the return query names', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(paidOrder());

      const result = await adapter.confirm({
        ...args,
        rawPayload: { payment_id: '999', status: 'approved' },
      });

      expect(api.getOrder).toHaveBeenCalledWith({
        accessToken: 'APP_USR-store',
        orderId: ORDER_ID,
      });
      expect(api.getPayment).not.toHaveBeenCalled();
      expect(result.status).toBe('COMPLETED');
      expect(result.providerPaymentId).toBe('PAY01JQ4S4KY8HWQ6NA5PXB65B3D4');
    });

    it('reads the order, not the payment a webhook named', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(paidOrder({ status: 'failed' }));
      const result = await adapter.resolve({
        ...args,
        providerPaymentId: '555',
      });
      expect(api.getPayment).not.toHaveBeenCalled();
      expect(result.status).toBe('FAILED');
    });

    it('looks a stale payment up by its order, not by search', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(
        paidOrder({ status: 'created', status_detail: 'created' }),
      );
      const result = await adapter.lookup(args);
      expect(api.findPaymentByReference).not.toHaveBeenCalled();
      expect(result.status).toBe('PROCESSING');
    });

    it("refuses an order that carries another payment's reference", async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(
        paidOrder({ external_reference: 'ekoru-pay-12' }),
      );
      const result = await adapter.confirm({ ...args, rawPayload: {} });
      expect(result.status).toBe('PROCESSING');
      expect(result.raw).toEqual(
        expect.objectContaining({ reason: 'reference_mismatch' }),
      );
    });

    it('fails a paid order for the wrong amount', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(paidOrder({ total_amount: '100' }));
      const result = await adapter.confirm({ ...args, rawPayload: {} });
      expect(result.status).toBe('FAILED');
    });

    it("completes a payment whose buyer's installment interest made it larger", async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(paidOrder({ total_paid_amount: '21800' }));
      const result = await adapter.confirm({ ...args, rawPayload: {} });
      expect(result.status).toBe('COMPLETED');
    });
  });

  describe('refund', () => {
    const refundArgs = {
      paymentId: 77,
      refundId: 3,
      externalId: ORDER_ID,
      externalToken: 'PAY01JQ4S4KY8HWQ6NA5PXB65B3D4',
      config,
    };

    it('gives back a whole untouched charge with a full refund', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(paidOrder());
      api.refundOrder.mockResolvedValue(
        paidOrder({
          status: 'refunded',
          transactions: {
            payments: [],
            refunds: [
              {
                id: 'REF01',
                transaction_id: 'PAY01JQ4S4KY8HWQ6NA5PXB65B3D4',
                amount: '20000',
                status: 'processing',
              },
            ],
          },
        }),
      );

      const result = await adapter.refund({ ...refundArgs, amount: 20000 });

      expect(api.refundOrder).toHaveBeenCalledWith({
        accessToken: 'APP_USR-store',
        orderId: ORDER_ID,
        idempotencyKey: 'ekoru-refund-3',
      });
      expect(result).toEqual(
        expect.objectContaining({ ok: true, externalRefundId: 'REF01' }),
      );
    });

    it('names the payment and amount for part of a charge', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(paidOrder());
      api.refundOrder.mockResolvedValue(paidOrder());

      await adapter.refund({ ...refundArgs, amount: 5000 });

      expect(api.refundOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          transactions: [
            { id: 'PAY01JQ4S4KY8HWQ6NA5PXB65B3D4', amount: '5000' },
          ],
        }),
      );
    });

    it('reports a refund Mercado Pago failed', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(paidOrder());
      api.refundOrder.mockResolvedValue(
        paidOrder({
          transactions: {
            refunds: [{ id: 'REF02', amount: '5000', status: 'failed' }],
          },
        }),
      );
      const result = await adapter.refund({ ...refundArgs, amount: 5000 });
      expect(result.ok).toBe(false);
    });

    it('refunds nothing on an order that was never paid', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(
        paidOrder({ status: 'created', transactions: { payments: [] } }),
      );
      const result = await adapter.refund({ ...refundArgs, amount: 5000 });
      expect(result.ok).toBe(false);
      expect(api.refundOrder).not.toHaveBeenCalled();
    });

    it('still refunds a Preferences payment through its Mercado Pago payment', async () => {
      const { adapter, api } = make(orders);
      api.refund.mockResolvedValue({ id: 9, status: 'approved' });
      await adapter.refund({
        ...refundArgs,
        externalId: '202809963-920c288b-4ebb-40be-966f-700250fa5370',
        externalToken: '555',
        amount: 5000,
      });
      expect(api.refundOrder).not.toHaveBeenCalled();
      expect(api.refund).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: '555' }),
      );
    });
  });

  describe('inspect (TRX-22)', () => {
    it('reads refunds made from the store account off the order', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(
        paidOrder({
          status_detail: 'partially_refunded',
          transactions: {
            payments: [
              {
                id: 'PAY01',
                status: 'processed',
                amount: '20000',
                refunded_amount: '5000',
              },
            ],
          },
        }),
      );
      const charge = await adapter.inspect({
        providerPaymentId: ORDER_ID,
        externalId: ORDER_ID,
        config,
      });
      expect(api.getPayment).not.toHaveBeenCalled();
      expect(charge).toEqual(
        expect.objectContaining({
          paymentId: 77,
          status: 'processed',
          refunded: 5000,
        }),
      );
    });

    it('reports a chargeback in the Payments API words', async () => {
      const { adapter, api } = make();
      api.getOrder.mockResolvedValue(
        paidOrder({
          transactions: {
            payments: [{ id: 'PAY01', status: 'processed' }],
            chargebacks: [{ id: 'CHB01', status: 'opened' }],
          },
        }),
      );
      const charge = await adapter.inspect({
        providerPaymentId: ORDER_ID,
        externalId: ORDER_ID,
        config,
      });
      expect(charge.status).toBe('charged_back');
    });
  });

  it('treats a payment this store cannot see as not ours', async () => {
    const { adapter, api } = make();
    api.getPayment.mockRejectedValue(
      new MercadoPagoApiError(404, { message: 'not found' }, '/v1/payments'),
    );
    await expect(
      adapter.identify({ providerPaymentId: '555', config }),
    ).resolves.toBeNull();
  });

  it('lets any other error through, so the webhook is retried', async () => {
    const { adapter, api } = make();
    api.getPayment.mockRejectedValue(
      new MercadoPagoApiError(500, {}, '/v1/payments'),
    );
    await expect(
      adapter.identify({ providerPaymentId: '555', config }),
    ).rejects.toBeInstanceOf(MercadoPagoApiError);
  });
});

describe('Mercado Pago helpers', () => {
  it.each([
    ['approved', 'COMPLETED'],
    ['rejected', 'FAILED'],
    ['cancelled', 'CANCELLED'],
    ['pending', 'PROCESSING'],
    ['in_process', 'PROCESSING'],
    [undefined, 'PROCESSING'],
  ])('maps %s to %s', (status, expected) => {
    expect(mapMercadoPagoStatus(status)).toBe(expected);
  });

  it.each([
    ['processed', 'accredited', 'COMPLETED'],
    ['processed', 'partially_refunded', 'COMPLETED'],
    ['processed', 'refunded', 'PROCESSING'],
    ['refunded', 'refunded', 'PROCESSING'],
    ['failed', 'processing_error', 'FAILED'],
    ['canceled', 'canceled', 'CANCELLED'],
    ['expired', 'expired', 'EXPIRED'],
    ['created', 'created', 'PROCESSING'],
    ['action_required', 'waiting_payment', 'PROCESSING'],
    [undefined, undefined, 'PROCESSING'],
  ])('maps the order status %s/%s to %s', (status, detail, expected) => {
    expect(mapMercadoPagoOrderStatus(status, detail)).toBe(expected);
  });

  it('tells an order id from a preference id', () => {
    expect(isMercadoPagoOrderId(ORDER_ID)).toBe(true);
    expect(
      isMercadoPagoOrderId('202809963-920c288b-4ebb-40be-966f-700250fa5370'),
    ).toBe(false);
    expect(isMercadoPagoOrderId('pref-1')).toBe(false);
    expect(isMercadoPagoOrderId(null)).toBe(false);
  });

  it('writes amounts as the decimal strings the Orders API takes', () => {
    expect(mercadoPagoAmount(20000)).toBe('20000');
    expect(mercadoPagoAmount(10.5)).toBe('10.50');
  });

  it('reads our payment id from a reference, and nothing else', () => {
    expect(paymentIdFromReference('ekoru-pay-77')).toBe(77);
    expect(paymentIdFromReference('ekoru-pay-77x')).toBeNull();
    expect(paymentIdFromReference('other-77')).toBeNull();
    expect(paymentIdFromReference(77)).toBeNull();
  });
});
