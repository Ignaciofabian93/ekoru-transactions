import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { InternalServerError } from '../common/exceptions/index.js';
import type { InitiatePaymentArgs } from './providers/index.js';

/** Marks a sealed value: `enc:v1:<iv>.<tag>.<ciphertext>`, each base64url. */
const PREFIX = 'enc:v1:';

/** Whether a stored value is already sealed (anything else is legacy plain text). */
export const isSealed = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.startsWith(PREFIX);

/** AES-256-GCM with a fresh 12-byte IV; the tag makes tampering detectable. */
export function sealSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`;
}

/** The plain value of a sealed one; throws if it was altered or sealed with another key. */
export function openSecret(sealed: string, key: Buffer): string {
  const [iv, tag, data] = sealed.slice(PREFIX.length).split('.');
  if (!iv || !tag || data === undefined) {
    throw new Error('Malformed sealed secret');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

type CredentialRow = {
  environment: 'SANDBOX' | 'PRODUCTION';
  merchantId: string | null;
  apiKey: string | null;
  secretKey: string | null;
};

/**
 * Provider secrets at rest (TRX-21). `ChileanPaymentConfig.apiKey`,
 * `secretKey` and `refreshToken` hold stores' Mercado Pago tokens and Webpay
 * keys, which can charge and refund on their accounts. They are sealed with
 * AES-256-GCM under `PAYMENT_SECRETS_KEY` (32 bytes, base64) before they are
 * written, and opened only where a provider call needs them.
 *
 * Legacy plain-text values still read as they are, and `sealExistingRows`
 * seals them once the key is configured. Production refuses to write a secret
 * without the key; elsewhere it falls back to plain text with a warning.
 */
@Injectable()
export class PaymentSecrets {
  private readonly logger = new Logger(PaymentSecrets.name);
  private warned = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** The value to store. null/undefined/'' pass through, so "clear" and "keep" still work. */
  seal<T extends string | null | undefined>(value: T): T {
    if (!value || isSealed(value)) return value;
    const key = this.key();
    if (!key) {
      if (this.config.get<string>('ENVIRONMENT') === 'production') {
        throw new InternalServerError(
          'PAYMENT_SECRETS_KEY no configurado: no se guardan credenciales sin cifrar en producción',
        );
      }
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'PAYMENT_SECRETS_KEY is not set: payment credentials are stored in plain text',
        );
      }
      return value;
    }
    return sealSecret(value, key) as T;
  }

  /** The plain value of a stored one (legacy plain text is returned as is). */
  open(value: string | null): string | null {
    if (!value || !isSealed(value)) return value;
    const key = this.key();
    if (!key) {
      throw new InternalServerError(
        'PAYMENT_SECRETS_KEY no configurado: no se pueden leer las credenciales de pago',
      );
    }
    try {
      return openSecret(value, key);
    } catch {
      throw new InternalServerError(
        'No se pudieron leer las credenciales de pago (¿cambió PAYMENT_SECRETS_KEY?)',
      );
    }
  }

  /** The credentials an adapter acts with, opened. */
  credentials(row: CredentialRow): InitiatePaymentArgs['config'] {
    return {
      environment: row.environment,
      merchantId: row.merchantId,
      apiKey: this.open(row.apiKey),
      secretKey: this.open(row.secretKey),
    };
  }

  /**
   * Seals every stored secret still in plain text. Runs once per boot; a few
   * rows at most, and a no-op without the key.
   */
  async sealExistingRows(): Promise<number> {
    if (!this.key()) return 0;
    const rows = await this.prisma.chileanPaymentConfig.findMany({
      where: {
        OR: [
          { apiKey: { not: null } },
          { secretKey: { not: null } },
          { refreshToken: { not: null } },
        ],
      },
      select: { id: true, apiKey: true, secretKey: true, refreshToken: true },
    });
    let sealed = 0;
    for (const row of rows) {
      const plain = [row.apiKey, row.secretKey, row.refreshToken].some(
        (v) => !!v && !isSealed(v),
      );
      if (!plain) continue;
      await this.prisma.chileanPaymentConfig.update({
        where: { id: row.id },
        data: {
          apiKey: this.seal(row.apiKey),
          secretKey: this.seal(row.secretKey),
          refreshToken: this.seal(row.refreshToken),
        },
      });
      sealed++;
    }
    if (sealed)
      this.logger.log(`Sealed the secrets of ${sealed} payment config(s)`);
    return sealed;
  }

  private key(): Buffer | null {
    const raw = this.config.get<string>('payments.secretsKey');
    if (!raw) return null;
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new InternalServerError(
        'PAYMENT_SECRETS_KEY debe ser 32 bytes en base64 (openssl rand -base64 32)',
      );
    }
    return key;
  }
}
