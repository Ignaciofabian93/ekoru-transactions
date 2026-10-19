import type { ConfigService } from '@nestjs/config';
import {
  MercadoPagoAdapter,
  mapMercadoPagoStatus,
  paymentIdFromReference,
} from './mercadopago.adapter.js';
import type { MercadoPagoApi } from '../mercadopago/mercadopago.api.js';

const config = {
  environment: 'PRODUCTION' as const,
  merchantId: '123',
  apiKey: null,
  secretKey: 'APP_USR-store',
};

function make() {
  const api = {
    createPreference: jest.fn().mockResolvedValue({
      id: 'pref-1',
      init_point:
        'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=pref-1',
    }),
    getPayment: jest.fn(),
    findPaymentByReference: jest.fn(),
    refund: jest.fn(),
  };
  const values: Record<string, unknown> = {
    gatewayBaseUrl: 'https://api.ekoru.cl',
    'payments.expireAfterMinutes': 60,
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

  it('reads our payment id from a reference, and nothing else', () => {
    expect(paymentIdFromReference('ekoru-pay-77')).toBe(77);
    expect(paymentIdFromReference('ekoru-pay-77x')).toBeNull();
    expect(paymentIdFromReference('other-77')).toBeNull();
    expect(paymentIdFromReference(77)).toBeNull();
  });
});
