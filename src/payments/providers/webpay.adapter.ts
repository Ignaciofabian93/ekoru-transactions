import { Injectable, Logger } from '@nestjs/common';
import { InternalServerError } from '../../common/exceptions/index.js';
import type {
  ConfirmPaymentArgs,
  ConfirmPaymentResult,
  InitiatePaymentArgs,
  InitiatePaymentResult,
  ProviderAdapter,
} from './provider-adapter.js';

/**
 * Webpay Plus (Transbank) adapter.
 *
 * Sandbox vs production:
 *   - SANDBOX → uses Transbank's integration commerce code WEBPAY_PLUS
 *     (`597055555532`) and the public integration API key. ANY seller with
 *     environment=SANDBOX shares those credentials — fine for dev, not for
 *     real money.
 *   - PRODUCTION → uses the seller's own merchantId + secretKey from
 *     ChileanPaymentConfig.
 *
 * Flow:
 *   1. `tx.create(buyOrder, sessionId, amount, returnUrl)` → returns
 *      `{ token, url }`. URL is Transbank's hosted form page.
 *   2. Frontend submits a hidden HTML form POST to `url` with field
 *      `name="token_ws"` set to `token`. (Webpay does NOT accept GET.)
 *   3. After the buyer pays, Transbank POSTs `token_ws` to `returnUrl`.
 *   4. We call `tx.commit(token)` to finalize and read the result.
 */
@Injectable()
export class WebpayAdapter implements ProviderAdapter {
  private readonly logger = new Logger(WebpayAdapter.name);

  /**
   * Lazy-loads the SDK so the subgraph can boot even if `transbank-sdk` is
   * not installed yet during the migration window.
   */
  private async loadSdk() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const sdk = await import('transbank-sdk');
      return sdk;
    } catch {
      throw new InternalServerError(
        'transbank-sdk no está instalado. Ejecuta `npm i transbank-sdk` para habilitar Webpay.',
      );
    }
  }

  async initiate(args: InitiatePaymentArgs): Promise<InitiatePaymentResult> {
    const sdk = await this.loadSdk();
    const {
      WebpayPlus,
      Options,
      IntegrationCommerceCodes,
      IntegrationApiKeys,
      Environment,
    } = sdk as any; // eslint-disable-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment

    const isProd = args.config.environment === 'PRODUCTION';
    const commerceCode = isProd
      ? args.config.merchantId
      : IntegrationCommerceCodes.WEBPAY_PLUS;
    const apiKey = isProd
      ? args.config.secretKey
      : IntegrationApiKeys.WEBPAY;
    const env = isProd ? Environment.Production : Environment.Integration;

    if (!commerceCode || !apiKey) {
      throw new InternalServerError(
        'Configuración de Webpay incompleta para este vendedor (PRODUCTION sin merchantId/secretKey)',
      );
    }

    // Webpay buyOrder must be ≤ 26 chars and unique per transaction.
    const buyOrder = `ekoru-${args.orderId}-${Date.now().toString(36)}`.slice(0, 26);
    const sessionId = `s-${args.paymentId}`.slice(0, 61);

    const tx = new WebpayPlus.Transaction(new Options(commerceCode, apiKey, env)); // eslint-disable-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const response = (await tx.create(buyOrder, sessionId, args.amount, args.returnUrl)) as {
      token: string;
      url: string;
    };

    return {
      externalId: buyOrder,
      externalToken: response.token,
      redirect: {
        kind: 'WEBPAY_FORM',
        url: response.url,
        token: response.token,
      },
    };
  }

  async confirm(args: ConfirmPaymentArgs): Promise<ConfirmPaymentResult> {
    const sdk = await this.loadSdk();
    const { WebpayPlus, Options, IntegrationCommerceCodes, IntegrationApiKeys, Environment } =
      sdk as any; // eslint-disable-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment

    const token = args.externalToken ?? (args.rawPayload['token_ws'] as string | undefined);
    if (!token) {
      this.logger.warn('Webpay confirm called without a token');
      return { status: 'FAILED', raw: { reason: 'missing_token' } };
    }

    const isProd = args.config.environment === 'PRODUCTION';
    const commerceCode = isProd
      ? args.config.merchantId
      : IntegrationCommerceCodes.WEBPAY_PLUS;
    const apiKey = isProd
      ? args.config.secretKey
      : IntegrationApiKeys.WEBPAY;
    const env = isProd ? Environment.Production : Environment.Integration;

    const tx = new WebpayPlus.Transaction(new Options(commerceCode, apiKey, env)); // eslint-disable-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access

    try {
      const result = (await tx.commit(token)) as {
        status: string;
        response_code: number;
        authorization_code?: string;
      };
      const status =
        result.status === 'AUTHORIZED' && result.response_code === 0
          ? ('COMPLETED' as const)
          : ('FAILED' as const);
      return { status, raw: result as unknown as Record<string, unknown> };
    } catch (err) {
      this.logger.error('Webpay commit failed', err);
      return {
        status: 'FAILED',
        raw: { error: err instanceof Error ? err.message : 'unknown' },
      };
    }
  }

  async handleWebhook(_payload: Record<string, unknown>): Promise<ConfirmPaymentResult> {
    // Webpay Plus doesn't push async webhooks — the return-URL POST IS the
    // notification. Calling this is a no-op.
    return { status: 'PROCESSING', raw: { note: 'webpay_no_webhook' } };
  }
}
