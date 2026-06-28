import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { InternalServerError } from '../../common/exceptions/index.js';
import type {
  ConfirmPaymentArgs,
  ConfirmPaymentResult,
  InitiatePaymentArgs,
  InitiatePaymentResult,
  ProviderAdapter,
} from './provider-adapter.js';

/**
 * Khipu (Chilean bank transfer) adapter — Payments API v3.
 *
 * v3 auth is a single `x-api-key` header. The seller's `apiKey` field on
 * ChileanPaymentConfig holds that, and `secretKey` holds the HMAC secret used
 * to verify webhook signatures.
 *
 * Flow:
 *   1. POST /payments → returns `{ payment_id, payment_url, simplified_transfer_url, ... }`.
 *   2. Frontend redirects to `payment_url`.
 *   3. Khipu calls our webhook (`notify_url`) when the transfer settles.
 *   4. We verify the HMAC-SHA256 signature (`x-khipu-signature` header).
 */
@Injectable()
export class KhipuAdapter implements ProviderAdapter {
  private readonly logger = new Logger(KhipuAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return 'https://payment-api.khipu.com/v3';
  }

  private gatewayBase(): string {
    const url = this.config.get<string>('gatewayBaseUrl');
    if (!url) throw new InternalServerError('GATEWAY_BASE_URL no configurado');
    return url;
  }

  async initiate(args: InitiatePaymentArgs): Promise<InitiatePaymentResult> {
    if (!args.config.apiKey) {
      throw new InternalServerError(
        'Configuración de Khipu incompleta: falta apiKey',
      );
    }

    const body = {
      amount: args.amount,
      currency: args.currency,
      subject: args.description.slice(0, 255),
      transaction_id: `ekoru-${args.orderId}`,
      return_url: args.returnUrl,
      cancel_url: `${args.returnUrl}?status=cancelled`,
      notify_url: `${this.gatewayBase()}/payments/webhook/khipu`,
      notify_api_version: '3.0',
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': args.config.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error('Khipu unreachable', err);
      throw new InternalServerError('No se pudo contactar a Khipu');
    }

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Khipu returned ${res.status}: ${text}`);
      throw new InternalServerError(
        `Error al crear el pago en Khipu (${res.status})`,
      );
    }

    const data = (await res.json()) as {
      payment_id: string;
      payment_url: string;
      simplified_transfer_url?: string;
      transfer_url?: string;
    };

    return {
      externalId: data.payment_id,
      externalToken: null,
      redirect: {
        kind: 'EXTERNAL',
        // Prefer simplified flow when available — fewer clicks for the buyer.
        url: data.simplified_transfer_url ?? data.payment_url,
      },
    };
  }

  async confirm(args: ConfirmPaymentArgs): Promise<ConfirmPaymentResult> {
    // Khipu's return URL is informational only — the authoritative event is
    // the webhook. The buyer might land on the confirmation page before the
    // webhook arrives, so we mark as PROCESSING and let polling resolve it.
    return {
      status: 'PROCESSING',
      raw: { source: 'khipu_return', externalId: args.externalId },
    };
  }

  async handleWebhook(payload: Record<string, unknown>): Promise<ConfirmPaymentResult> {
    // Khipu v3 webhook body shape (simplified):
    //   { payment_id, status, transaction_id, amount, ... }
    const status = payload.status as string | undefined;
    const mapped =
      status === 'done'
        ? ('COMPLETED' as const)
        : status === 'rejected'
          ? ('FAILED' as const)
          : status === 'expired'
            ? ('EXPIRED' as const)
            : ('PROCESSING' as const);
    return { status: mapped, raw: payload };
  }

  /**
   * Verifies the `x-khipu-signature` header against the raw request body.
   * Called from the gateway webhook handler before invoking `handleWebhook`.
   * Returns `true` only on a constant-time match.
   */
  verifySignature(
    rawBody: string,
    signatureHeader: string,
    secret: string,
  ): boolean {
    if (!signatureHeader || !secret) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
