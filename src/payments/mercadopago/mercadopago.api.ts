import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** What `/oauth/token` answers for the authorization-code and refresh grants. */
export interface MercadoPagoToken {
  access_token: string;
  token_type: string;
  /** Seconds; 15552000 (180 days) for the authorization-code grant. */
  expires_in: number;
  scope: string;
  /** The connected account; payments to it carry this as `collector_id`. */
  user_id: number;
  refresh_token: string;
  public_key: string;
  live_mode: boolean;
}

/** The fields of `/v1/payments/{id}` EKORU reads. */
export interface MercadoPagoPayment {
  id: number;
  /** pending | approved | authorized | in_process | in_mediation | rejected | cancelled | refunded | charged_back */
  status: string;
  status_detail?: string | null;
  external_reference?: string | null;
  transaction_amount: number;
  transaction_amount_refunded?: number;
  currency_id?: string;
  collector_id?: number | string | null;
  date_approved?: string | null;
}

export interface MercadoPagoPreference {
  id: string;
  init_point: string;
  collector_id?: number;
}

export interface MercadoPagoRefund {
  id: number;
  payment_id: number;
  amount: number;
  /** approved | in_process | rejected | cancelled | authorized */
  status: string;
}

/** A Mercado Pago API call answered with an error status. */
export class MercadoPagoApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    path: string,
  ) {
    super(
      `Mercado Pago ${status} on ${path}: ${
        typeof body['message'] === 'string'
          ? body['message']
          : typeof body['error'] === 'string'
            ? body['error']
            : 'error'
      }`,
    );
  }

  /** The grant is no longer usable (revoked or expired refresh token): reconnect. */
  get isInvalidGrant(): boolean {
    return (
      this.status === 400 &&
      (this.body['error'] === 'invalid_grant' ||
        this.body['message'] === 'invalid_grant')
    );
  }
}

const TIMEOUT_MS = 15_000;

/**
 * Thin REST client for the Mercado Pago endpoints the marketplace uses. Plain
 * `fetch` rather than the SDK: five calls, no extra dependency, and each one
 * names the access token it acts with — a store's own token, obtained with
 * OAuth, for everything about its sales.
 *
 * Reference: https://www.mercadopago.cl/developers/es/reference
 */
@Injectable()
export class MercadoPagoApi {
  private readonly logger = new Logger(MercadoPagoApi.name);

  constructor(private readonly config: ConfigService) {}

  // ─── OAuth (application credentials) ──────────────────────────────────────

  /** Trades the code a store brought back from the authorization page for its tokens. */
  exchangeCode({
    code,
    redirectUri,
    codeVerifier,
    testToken,
  }: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    testToken: boolean;
  }): Promise<MercadoPagoToken> {
    return this.request<MercadoPagoToken>('POST', '/oauth/token', {
      body: {
        ...this.appCredentials(),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        ...(testToken ? { test_token: 'true' } : {}),
      },
    });
  }

  /** A new access token (and a new refresh token, which replaces the old one). */
  refreshToken(refreshToken: string): Promise<MercadoPagoToken> {
    return this.request<MercadoPagoToken>('POST', '/oauth/token', {
      body: {
        ...this.appCredentials(),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    });
  }

  // ─── Store-scoped calls (the store's own access token) ────────────────────

  createPreference({
    accessToken,
    body,
    idempotencyKey,
  }: {
    accessToken: string;
    body: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<MercadoPagoPreference> {
    return this.request<MercadoPagoPreference>(
      'POST',
      '/checkout/preferences',
      { accessToken, body, idempotencyKey },
    );
  }

  getPayment({
    accessToken,
    paymentId,
  }: {
    accessToken: string;
    paymentId: string;
  }): Promise<MercadoPagoPayment> {
    return this.request<MercadoPagoPayment>(
      'GET',
      `/v1/payments/${encodeURIComponent(paymentId)}`,
      { accessToken },
    );
  }

  /** The newest payment carrying our reference, for a buyer who never came back. */
  async findPaymentByReference({
    accessToken,
    externalReference,
  }: {
    accessToken: string;
    externalReference: string;
  }): Promise<MercadoPagoPayment | null> {
    const query = new URLSearchParams({
      external_reference: externalReference,
      sort: 'date_created',
      criteria: 'desc',
      limit: '10',
    });
    const page = await this.request<{ results?: MercadoPagoPayment[] }>(
      'GET',
      `/v1/payments/search?${query.toString()}`,
      { accessToken },
    );
    const results = page.results ?? [];
    // An approved attempt wins over later rejected ones for the same checkout.
    return results.find((p) => p.status === 'approved') ?? results[0] ?? null;
  }

  /** Full refund without `amount`; Mercado Pago splits it with the marketplace fee proportionally. */
  refund({
    accessToken,
    paymentId,
    amount,
    idempotencyKey,
  }: {
    accessToken: string;
    paymentId: string;
    amount?: number;
    idempotencyKey: string;
  }): Promise<MercadoPagoRefund> {
    return this.request<MercadoPagoRefund>(
      'POST',
      `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
      {
        accessToken,
        body: amount == null ? {} : { amount },
        idempotencyKey,
      },
    );
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private appCredentials() {
    const clientId = this.config.get<string>('mercadoPago.clientId');
    const clientSecret = this.config.get<string>('mercadoPago.clientSecret');
    if (!clientId || !clientSecret) {
      throw new Error(
        'MERCADOPAGO_CLIENT_ID / MERCADOPAGO_CLIENT_SECRET no configurados',
      );
    }
    return { client_id: clientId, client_secret: clientSecret };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    {
      accessToken,
      body,
      idempotencyKey,
    }: {
      accessToken?: string;
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const base = this.config.get<string>(
      'mercadoPago.apiBaseUrl',
      'https://api.mercadopago.com',
    );
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { message: text.slice(0, 300) };
    }
    if (!res.ok) {
      // The path never carries a token; the body of an error never echoes one.
      this.logger.warn(
        `Mercado Pago ${method} ${path.split('?')[0]} → ${res.status}`,
      );
      throw new MercadoPagoApiError(res.status, parsed, path.split('?')[0]);
    }
    return parsed as T;
  }
}
