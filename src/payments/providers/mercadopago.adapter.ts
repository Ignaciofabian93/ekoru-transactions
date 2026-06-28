import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalServerError } from '../../common/exceptions/index.js';
import type {
  ConfirmPaymentArgs,
  ConfirmPaymentResult,
  InitiatePaymentArgs,
  InitiatePaymentResult,
  ProviderAdapter,
} from './provider-adapter.js';

/**
 * MercadoPago Checkout Pro adapter.
 *
 * Auth: a single access token per seller, held in
 * `ChileanPaymentConfig.secretKey`. Same token works for both sandbox and
 * production — MercadoPago distinguishes by token prefix (`TEST-` vs `APP_USR-`),
 * so we don't read `environment` here.
 *
 * Flow:
 *   1. Create a Preference → returns `{ id, init_point, sandbox_init_point }`.
 *   2. Frontend redirects to `init_point` (production) or `sandbox_init_point`.
 *   3. After payment, MercadoPago redirects to `back_urls.success` and also
 *      sends an IPN/webhook to `notification_url`. Webhook = source of truth.
 */
@Injectable()
export class MercadoPagoAdapter implements ProviderAdapter {
  private readonly logger = new Logger(MercadoPagoAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private async loadSdk() {
    try {
      const sdk = await import('mercadopago');
      return sdk;
    } catch {
      throw new InternalServerError(
        'mercadopago no está instalado. Ejecuta `npm i mercadopago` para habilitar MercadoPago.',
      );
    }
  }

  private gatewayBase(): string {
    const url = this.config.get<string>('gatewayBaseUrl');
    if (!url) throw new InternalServerError('GATEWAY_BASE_URL no configurado');
    return url;
  }

  async initiate(args: InitiatePaymentArgs): Promise<InitiatePaymentResult> {
    if (!args.config.secretKey) {
      throw new InternalServerError(
        'Configuración de MercadoPago incompleta: falta accessToken',
      );
    }

    const sdk = (await this.loadSdk()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const client = new sdk.MercadoPagoConfig({ accessToken: args.config.secretKey });
    const preference = new sdk.Preference(client);

    const result = (await preference.create({
      body: {
        items: [
          {
            id: String(args.orderId),
            title: args.description.slice(0, 100),
            quantity: 1,
            unit_price: args.amount,
            currency_id: args.currency,
          },
        ],
        external_reference: `ekoru-${args.orderId}`,
        back_urls: {
          success: args.returnUrl,
          failure: `${args.returnUrl}?status=failed`,
          pending: `${args.returnUrl}?status=pending`,
        },
        notification_url: `${this.gatewayBase()}/payments/webhook/mercadopago`,
        auto_return: 'approved',
      },
    })) as {
      id: string;
      init_point: string;
      sandbox_init_point?: string;
    };

    const isSandbox = args.config.environment === 'SANDBOX';
    const url = isSandbox
      ? (result.sandbox_init_point ?? result.init_point)
      : result.init_point;

    return {
      externalId: result.id,
      externalToken: null,
      redirect: { kind: 'EXTERNAL', url },
    };
  }

  async confirm(args: ConfirmPaymentArgs): Promise<ConfirmPaymentResult> {
    const status = args.rawPayload['status'] as string | undefined;
    if (status === 'approved') {
      return { status: 'COMPLETED', raw: args.rawPayload };
    }
    if (status === 'failed' || status === 'rejected') {
      return { status: 'FAILED', raw: args.rawPayload };
    }
    return { status: 'PROCESSING', raw: args.rawPayload };
  }

  /**
   * MercadoPago IPN/webhook payload typically has:
   *   { type: "payment", data: { id: "..." }, ... }
   * To get the canonical status we need to call back to MercadoPago's API
   * with the payment id. That requires the seller's accessToken, which the
   * gateway will need to look up from the order before calling this. The
   * gateway passes the resolved status in `payload.__status` to avoid the
   * adapter having to re-resolve credentials.
   */
  async handleWebhook(payload: Record<string, unknown>): Promise<ConfirmPaymentResult> {
    const resolved = payload['__status'] as string | undefined;
    const status =
      resolved === 'approved'
        ? ('COMPLETED' as const)
        : resolved === 'rejected'
          ? ('FAILED' as const)
          : resolved === 'cancelled'
            ? ('CANCELLED' as const)
            : ('PROCESSING' as const);
    return { status, raw: payload };
  }
}
