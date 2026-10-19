import type { ConfigService } from '@nestjs/config';
import { MercadoPagoConnectService } from './mercadopago-connect.service.js';
import { MercadoPagoApiError, type MercadoPagoApi } from './mercadopago.api.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CommissionService } from '../commission.service.js';
import { PaymentSecrets } from '../payment-secrets.js';
import { BadRequestError } from '../../common/exceptions/index.js';

function make(settings: Record<string, unknown> = {}) {
  const prisma = {
    chileanPaymentConfig: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const api = { exchangeCode: jest.fn(), refreshToken: jest.fn() };
  const commission = {
    quote: jest.fn().mockResolvedValue({ rate: 0.05 }),
  };
  const values: Record<string, unknown> = {
    'mercadoPago.clientId': '1234567890',
    'mercadoPago.clientSecret': 'app-secret',
    'mercadoPago.redirectUri': 'https://admin.ekoru.cl/payment-setup',
    'mercadoPago.webRedirectUri': 'https://ekoru.cl/profile/payments',
    'mercadoPago.authBaseUrl': 'https://auth.mercadopago.com',
    'mercadoPago.usePkce': true,
    'mercadoPago.testToken': false,
    ...settings,
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
    ),
  };
  return {
    service: new MercadoPagoConnectService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      api as unknown as MercadoPagoApi,
      commission as unknown as CommissionService,
      new PaymentSecrets(
        { get: () => undefined } as unknown as ConfigService,
        prisma as unknown as PrismaService,
      ),
    ),
    prisma,
    api,
  };
}

const token = {
  access_token: 'APP_USR-store',
  token_type: 'bearer',
  expires_in: 15552000,
  scope: 'offline_access read write',
  user_id: 123,
  refresh_token: 'TG-refresh',
  public_key: 'APP_USR-public',
  live_mode: true,
};

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

describe('MercadoPagoConnectService', () => {
  it('sends the business to the authorization page with state and PKCE', () => {
    const { service } = make();
    const url = new URL(
      service.authorizationUrl({
        sellerId: 'store',
        actor: 'admin:admin',
        surface: 'panel',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://auth.mercadopago.com/authorization',
    );
    expect(url.searchParams.get('client_id')).toBe('1234567890');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://admin.ekoru.cl/payment-setup',
    );
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('stores the connection once the code is exchanged', async () => {
    const { service, prisma, api } = make();
    api.exchangeCode.mockResolvedValue(token);
    const state = stateOf(
      service.authorizationUrl({
        sellerId: 'store',
        actor: 'admin:admin',
        surface: 'panel',
      }),
    );

    await service.complete({
      sellerId: 'store',
      actor: 'admin:admin',
      code: 'TG-code',
      state,
    });

    expect(api.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'TG-code',
        redirectUri: 'https://admin.ekoru.cl/payment-setup',
        codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        testToken: false,
      }),
    );
    const { create, update } =
      prisma.chileanPaymentConfig.upsert.mock.calls[0][0];
    expect(create).toEqual(
      expect.objectContaining({
        sellerId: 'store',
        provider: 'MERCADOPAGO',
        merchantId: '123',
        secretKey: 'APP_USR-store',
        refreshToken: 'TG-refresh',
        environment: 'PRODUCTION',
        isActive: true,
      }),
    );
    expect(update.tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('refuses a state started for another store or by another admin', async () => {
    const { service, api } = make();
    const state = stateOf(
      service.authorizationUrl({
        sellerId: 'store',
        actor: 'admin:admin',
        surface: 'panel',
      }),
    );
    await expect(
      service.complete({
        sellerId: 'other-store',
        actor: 'admin:admin',
        code: 'TG-code',
        state,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      service.complete({
        sellerId: 'store',
        actor: 'admin:someone-else',
        code: 'TG-code',
        state,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(api.exchangeCode).not.toHaveBeenCalled();
  });

  it('brings a business that started on the web back to the web', async () => {
    const { service, api } = make();
    api.exchangeCode.mockResolvedValue(token);
    const url = service.authorizationUrl({
      sellerId: 'store',
      actor: 'seller:store',
      surface: 'web',
    });
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'https://ekoru.cl/profile/payments',
    );

    await service.complete({
      sellerId: 'store',
      actor: 'seller:store',
      code: 'TG-code',
      state: stateOf(url),
    });

    // The exchange names the redirect URL the business was sent with.
    expect(api.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'https://ekoru.cl/profile/payments',
      }),
    );
  });

  it('does not let a panel admin finish what the business started on the web', async () => {
    const { service, api } = make();
    const state = stateOf(
      service.authorizationUrl({
        sellerId: 'store',
        actor: 'seller:store',
        surface: 'web',
      }),
    );
    await expect(
      service.complete({
        sellerId: 'store',
        actor: 'admin:admin',
        code: 'TG-code',
        state,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(api.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a forged state', async () => {
    const { service, api } = make();
    await expect(
      service.complete({
        sellerId: 'store',
        actor: 'admin:admin',
        code: 'TG-code',
        state: 'forged.state',
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(api.exchangeCode).not.toHaveBeenCalled();
  });

  it('reports a live connection, and a lost one as needing reconnection', async () => {
    const { service, prisma } = make();
    const future = new Date(Date.now() + 86_400_000);
    prisma.chileanPaymentConfig.findUnique.mockResolvedValueOnce({
      merchantId: '123',
      secretKey: 'APP_USR-store',
      refreshToken: 'TG-refresh',
      tokenExpiresAt: future,
      environment: 'PRODUCTION',
      isActive: true,
      updatedAt: new Date(),
    });
    expect(await service.status('store')).toEqual(
      expect.objectContaining({
        connected: true,
        needsReconnect: false,
        accountId: '123',
        commissionRate: 0.05,
      }),
    );

    prisma.chileanPaymentConfig.findUnique.mockResolvedValueOnce({
      merchantId: '123',
      secretKey: 'APP_USR-store',
      refreshToken: 'TG-refresh',
      tokenExpiresAt: future,
      environment: 'PRODUCTION',
      isActive: false,
      updatedAt: new Date(),
    });
    expect(await service.status('store')).toEqual(
      expect.objectContaining({ connected: false, needsReconnect: true }),
    );
  });

  it('renews expiring tokens and pauses the ones Mercado Pago refuses', async () => {
    const { service, prisma, api } = make();
    prisma.chileanPaymentConfig.findMany.mockResolvedValue([
      { id: 1, sellerId: 'a', refreshToken: 'TG-a' },
      { id: 2, sellerId: 'b', refreshToken: 'TG-b' },
    ]);
    api.refreshToken
      .mockResolvedValueOnce({ ...token, access_token: 'APP_USR-new' })
      .mockRejectedValueOnce(
        new MercadoPagoApiError(
          400,
          { error: 'invalid_grant' },
          '/oauth/token',
        ),
      );

    const result = await service.refreshExpiring();

    expect(result).toEqual({ refreshed: 1, paused: 1 });
    expect(prisma.chileanPaymentConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ secretKey: 'APP_USR-new' }),
      }),
    );
    expect(prisma.chileanPaymentConfig.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { isActive: false },
    });
  });
});
