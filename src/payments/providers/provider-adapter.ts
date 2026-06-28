import type {
  PaymentRedirectUnion,
} from '../entities/payment-redirect.entity.js';

export interface InitiatePaymentArgs {
  /** Internal Payment.id — used as the provider's commerce/transaction id. */
  paymentId: number;
  /** Internal Order.id — passed as external_reference where the provider supports it. */
  orderId: number;
  /** Charge amount in the order currency. CLP integers in v1. */
  amount: number;
  /** ISO 4217 — only "CLP" supported in v1. */
  currency: string;
  /** Short user-facing description (e.g. seller name). */
  description: string;
  /** Absolute URL the provider redirects the buyer to after pay/cancel. */
  returnUrl: string;
  /**
   * Provider credentials + environment for this seller, sourced from
   * ChileanPaymentConfig. Keep this provider-specific in the adapter — the
   * service shouldn't know about apiKey/secretKey/merchantId semantics.
   */
  config: {
    environment: 'SANDBOX' | 'PRODUCTION';
    merchantId: string | null;
    apiKey: string | null;
    secretKey: string | null;
  };
}

export interface InitiatePaymentResult {
  /** Provider's transaction id. Stored as Payment.externalId. */
  externalId: string;
  /** Provider's transaction token, if any. Stored as Payment.externalToken. */
  externalToken: string | null;
  /** What the frontend should do next to complete the payment. */
  redirect: PaymentRedirectUnion;
}

export interface ConfirmPaymentArgs {
  paymentId: number;
  externalId: string;
  externalToken: string | null;
  config: InitiatePaymentArgs['config'];
  /** Raw return payload from the provider (POST body for Webpay, query for others). */
  rawPayload: Record<string, unknown>;
}

export interface ConfirmPaymentResult {
  /** What the canonical Payment row should become. */
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'PROCESSING';
  /** Provider's own response, persisted on `PaymentWebhook`/`PaymentTransaction` for audit. */
  raw: Record<string, unknown>;
}

/**
 * Common shape every payment provider implements. The service layer holds
 * one adapter per ChileanPaymentProvider value and dispatches on the enum.
 *
 * The adapter is the only place that imports the provider's SDK. If a
 * provider's SDK is heavy, lazy-load it inside the method to keep the
 * subgraph cold-start cheap.
 */
export interface ProviderAdapter {
  initiate(args: InitiatePaymentArgs): Promise<InitiatePaymentResult>;
  /**
   * Called from the gateway's return-URL handler with whatever the provider
   * sent back. Returns the canonical status — the service then persists it.
   */
  confirm(args: ConfirmPaymentArgs): Promise<ConfirmPaymentResult>;
  /**
   * Called from the gateway's webhook handler. Some providers (Webpay) use
   * the return URL as the only signal; others (Khipu, MercadoPago) also send
   * an async webhook. Adapters that don't support webhooks throw here.
   */
  handleWebhook(payload: Record<string, unknown>): Promise<ConfirmPaymentResult>;
}
