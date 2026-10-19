import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import {
  PaymentSecrets,
  isSealed,
  openSecret,
  sealSecret,
} from './payment-secrets.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const KEY = randomBytes(32);

function make(settings: Record<string, unknown> = {}) {
  const prisma = {
    chileanPaymentConfig: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const values: Record<string, unknown> = {
    'payments.secretsKey': KEY.toString('base64'),
    ...settings,
  };
  const config = { get: jest.fn((key: string) => values[key]) };
  return {
    secrets: new PaymentSecrets(
      config as unknown as ConfigService,
      prisma as unknown as PrismaService,
    ),
    prisma,
  };
}

describe('sealSecret / openSecret', () => {
  it('round-trips, and never seals the same value the same way twice', () => {
    const a = sealSecret('APP_USR-store-token', KEY);
    const b = sealSecret('APP_USR-store-token', KEY);
    expect(isSealed(a)).toBe(true);
    expect(a).not.toContain('APP_USR');
    expect(a).not.toBe(b);
    expect(openSecret(a, KEY)).toBe('APP_USR-store-token');
  });

  it('refuses a value sealed with another key, or altered', () => {
    const sealed = sealSecret('secret', KEY);
    expect(() => openSecret(sealed, randomBytes(32))).toThrow();
    const altered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => openSecret(altered, KEY)).toThrow();
  });
});

describe('PaymentSecrets', () => {
  it('seals what it stores and opens it back for the adapters', () => {
    const { secrets } = make();
    const stored = secrets.seal('APP_USR-store-token');
    expect(isSealed(stored)).toBe(true);
    expect(
      secrets.credentials({
        environment: 'PRODUCTION',
        merchantId: '123',
        apiKey: null,
        secretKey: stored,
      }),
    ).toEqual({
      environment: 'PRODUCTION',
      merchantId: '123',
      apiKey: null,
      secretKey: 'APP_USR-store-token',
    });
  });

  it('keeps "clear" and "keep" meaning the same', () => {
    const { secrets } = make();
    expect(secrets.seal(null)).toBeNull();
    expect(secrets.seal(undefined)).toBeUndefined();
    expect(secrets.seal('')).toBe('');
  });

  it('reads legacy plain text as it is', () => {
    const { secrets } = make();
    expect(secrets.open('plain-legacy')).toBe('plain-legacy');
  });

  it('does not seal twice', () => {
    const { secrets } = make();
    const once = secrets.seal('x');
    expect(secrets.seal(once)).toBe(once);
  });

  it('refuses to store a secret without the key in production', () => {
    const { secrets } = make({
      'payments.secretsKey': undefined,
      ENVIRONMENT: 'production',
    });
    expect(() => secrets.seal('APP_USR-token')).toThrow('PAYMENT_SECRETS_KEY');
  });

  it('stores plain text without the key outside production', () => {
    const { secrets } = make({ 'payments.secretsKey': undefined });
    expect(secrets.seal('dev-token')).toBe('dev-token');
  });

  it('cannot open a sealed value once the key is gone', () => {
    const sealed = make().secrets.seal('x');
    const { secrets } = make({ 'payments.secretsKey': undefined });
    expect(() => secrets.open(sealed)).toThrow('PAYMENT_SECRETS_KEY');
  });

  it('rejects a key that is not 32 bytes', () => {
    const { secrets } = make({ 'payments.secretsKey': 'c2hvcnQ=' });
    expect(() => secrets.seal('x')).toThrow('32 bytes');
  });

  it('seals the rows stored in plain text, and only those', async () => {
    const { secrets, prisma } = make();
    const already = secrets.seal('sealed-before');
    prisma.chileanPaymentConfig.findMany.mockResolvedValue([
      {
        id: 1,
        apiKey: null,
        secretKey: 'plain',
        refreshToken: 'plain-refresh',
      },
      { id: 2, apiKey: null, secretKey: already, refreshToken: null },
    ]);

    await expect(secrets.sealExistingRows()).resolves.toBe(1);

    expect(prisma.chileanPaymentConfig.update).toHaveBeenCalledTimes(1);
    const { where, data } = prisma.chileanPaymentConfig.update.mock.calls[0][0];
    expect(where).toEqual({ id: 1 });
    expect(data.apiKey).toBeNull();
    expect(secrets.open(data.secretKey)).toBe('plain');
    expect(secrets.open(data.refreshToken)).toBe('plain-refresh');
  });

  it('leaves stored rows alone without a key', async () => {
    const { secrets, prisma } = make({ 'payments.secretsKey': undefined });
    await expect(secrets.sealExistingRows()).resolves.toBe(0);
    expect(prisma.chileanPaymentConfig.findMany).not.toHaveBeenCalled();
  });
});
