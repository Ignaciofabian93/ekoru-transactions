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
 *   3. After the buyer pays, Transbank POSTs back to `returnUrl`. The body
 *      shape depends on what happened — see `confirm()` for the four cases
 *      Transbank documents under "Requerimientos de página de resultado".
 *   4. We call `tx.commit(token_ws)` to finalize ONLY in the normal flow.
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
      const sdk = await import('transbank-sdk');
      // transbank-sdk is CommonJS. Under nodenext its named exports
      // (WebpayPlus, Options, IntegrationCommerceCodes, …) land on `.default`,
      // not the namespace top level — unwrap so callers can destructure them.

      return (sdk as any).default ?? sdk;
    } catch {
      throw new InternalServerError(
        'transbank-sdk no está instalado. Ejecuta `npm i transbank-sdk` para habilitar Webpay.',
      );
    }
  }

  /**
   * Builds a configured `WebpayPlus.Transaction`. Integration uses Transbank's
   * shared test credentials; production uses the seller's own commerce code +
   * API key. Centralized here so `initiate()` and `confirm()` can't drift.
   */
  private async buildTransaction(config: InitiatePaymentArgs['config']) {
    // loadSdk already unwraps the CommonJS interop and is typed `any`, so these
    // destructured members need no further assertion.
    const sdk = await this.loadSdk();
    const {
      WebpayPlus,
      Options,
      IntegrationCommerceCodes,
      IntegrationApiKeys,
      Environment,
    } = sdk;

    const isProd = config.environment === 'PRODUCTION';
    const commerceCode = isProd
      ? config.merchantId
      : IntegrationCommerceCodes.WEBPAY_PLUS;
    const apiKey = isProd ? config.secretKey : IntegrationApiKeys.WEBPAY;
    const env = isProd ? Environment.Production : Environment.Integration;

    if (!commerceCode || !apiKey) {
      throw new InternalServerError(
        'Configuración de Webpay incompleta para este vendedor (PRODUCTION sin merchantId/secretKey)',
      );
    }

    return new WebpayPlus.Transaction(new Options(commerceCode, apiKey, env));
  }

  async initiate(args: InitiatePaymentArgs): Promise<InitiatePaymentResult> {
    // Webpay buyOrder must be ≤ 26 chars and unique per transaction.
    const buyOrder = `ekoru-${args.orderId}-${Date.now().toString(36)}`.slice(
      0,
      26,
    );
    const sessionId = `s-${args.paymentId}`.slice(0, 61);

    const tx = await this.buildTransaction(args.config);
    const response = (await tx.create(
      buyOrder,
      sessionId,
      args.amount,
      args.returnUrl,
    )) as {
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

  /**
   * Resolves a Webpay return. Implements Transbank's "result page
   * requirements": the return URL can be hit in four distinct shapes and only
   * the first one is a real authorization that may be committed.
   *
   * https://www.transbankdevelopers.cl/documentacion/como_empezar#requerimientos-de-pagina-de-resultado
   *
   *   | token_ws | TBK_TOKEN | Meaning                                    | Action      |
   *   |----------|-----------|--------------------------------------------|-------------|
   *   | yes      | no        | Normal flow — buyer finished on the form   | commit()    |
   *   | no       | yes       | Buyer pressed "Anular" on the Webpay form  | CANCELLED   |
   *   | no       | no        | Form timeout (~10 min idle), never paid    | EXPIRED     |
   *   | yes      | yes       | Abnormal flow (e.g. double submit/timeout) | FAILED      |
   *
   * Only the raw return payload decides the case — never the token we stored
   * at create time, otherwise an aborted return would look "normal".
   */
  async confirm(args: ConfirmPaymentArgs): Promise<ConfirmPaymentResult> {
    const payload = args.rawPayload;
    const tokenWs = payload['token_ws'] as string | undefined;
    const tbkToken = payload['TBK_TOKEN'] as string | undefined;

    // Abnormal: both tokens arrive together → invalid, never commit.
    if (tokenWs && tbkToken) {
      this.logger.warn(
        'Webpay return carried token_ws and TBK_TOKEN together — treating as failed',
      );
      return {
        status: 'FAILED',
        raw: { reason: 'webpay_invalid_double_token', payload },
      };
    }

    // Buyer aborted on the Webpay form (pressed "Anular"): TBK_TOKEN, no token_ws.
    // The transaction was never authorized, so there is nothing to commit.
    if (!tokenWs && tbkToken) {
      return {
        status: 'CANCELLED',
        raw: { reason: 'webpay_user_aborted', payload },
      };
    }

    // Form timeout (buyer idle ~10 min): no token at all, only
    // TBK_ORDEN_COMPRA / TBK_ID_SESION. Nothing to commit.
    if (!tokenWs && !tbkToken) {
      return {
        status: 'EXPIRED',
        raw: { reason: 'webpay_form_timeout', payload },
      };
    }

    // Normal flow: token_ws present → commit and read the authorization result.
    const tx = await this.buildTransaction(args.config);
    try {
      const result = (await tx.commit(tokenWs)) as {
        status: string;
        response_code: number;
        authorization_code?: string;
        buy_order?: string;
      };
      // Webpay Plus: an approved card auth is status=AUTHORIZED + response_code=0.
      // Anything else (declined, insufficient funds, etc.) is a rejection.
      const approved =
        result.status === 'AUTHORIZED' && result.response_code === 0;
      return {
        status: approved ? 'COMPLETED' : 'FAILED',
        raw: result as unknown as Record<string, unknown>,
      };
    } catch (err) {
      this.logger.error('Webpay commit failed', err);
      return {
        status: 'FAILED',
        raw: { error: err instanceof Error ? err.message : 'unknown' },
      };
    }
  }

  // Webpay Plus doesn't push async webhooks — the return-URL POST IS the
  // notification. The ProviderAdapter signature passes a payload, but this
  // implementation ignores it, so the parameter is omitted. Nothing is awaited,
  // so it's a plain method returning a resolved promise rather than `async`.
  handleWebhook(): Promise<ConfirmPaymentResult> {
    return Promise.resolve({
      status: 'PROCESSING',
      raw: { note: 'webpay_no_webhook' },
    });
  }
}
