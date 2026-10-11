import { PaymentsService } from './payments.service.js';
import { ChileanPaymentProvider } from '../graphql/enums/index.js';
import { BadRequestError } from '../common/exceptions/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { ProviderRegistry } from './providers/index.js';
import type { SettlementService } from './settlement.service.js';
import type { ServicesClient, UsersClient } from '../common/clients/index.js';
import type { ConfigService } from '@nestjs/config';

function make() {
  const prisma = {
    payment: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    paymentTransaction: { create: jest.fn().mockResolvedValue({}) },
    chileanPaymentConfig: { findUnique: jest.fn(), findFirst: jest.fn() },
  };
  const adapter = { confirm: jest.fn(), initiate: jest.fn() };
  const providers = { for: jest.fn(() => adapter) };
  const settlement = { onCompleted: jest.fn() };
  const orders = { markCanceled: jest.fn() };
  const services = { getQuotationCharge: jest.fn() };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    orders as unknown as OrdersService,
    providers as unknown as ProviderRegistry,
    {} as UsersClient,
    { get: jest.fn() } as unknown as ConfigService,
    settlement as unknown as SettlementService,
    services as unknown as ServicesClient,
  );
  return { service, prisma, adapter, settlement, services, orders };
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
});
