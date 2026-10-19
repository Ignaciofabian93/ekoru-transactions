import type { PaymentRedirectUnion } from '../entities/payment-redirect.entity.js';

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
   * EKORU's commission on this charge, in the payment currency (TRX-10). A
   * provider that splits at source (Mercado Pago's `marketplace_fee`) takes it
   * there; one that cannot ignores it, and the Payment still records it.
   */
  platformFee?: number;
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
  /** What the Payment row expects to have been charged. */
  amount: number;
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
  /**
   * The provider's id for the charge, when only known once paid (Mercado
   * Pago's payment id). Stored as Payment.externalToken: refunds key on it.
   */
  providerPaymentId?: string;
}

export interface RefundArgs {
  /** Internal Payment.id, for logs. */
  paymentId: number;
  /** Internal PaymentRefund.id: makes a retried refund call idempotent. */
  refundId?: number;
  externalId: string | null;
  /** Webpay's transaction token: what its refund call is keyed on. */
  externalToken: string | null;
  /** Amount to give back, in the payment currency. */
  amount: number;
  config: InitiatePaymentArgs['config'];
}

export interface RefundResult {
  /** The provider confirmed the money goes back. */
  ok: boolean;
  /** Provider reference for the refund, when it gives one. */
  externalRefundId: string | null;
  /** Provider's own response, kept for audit. */
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
  handleWebhook(
    payload: Record<string, unknown>,
  ): Promise<ConfirmPaymentResult>;
  /**
   * Verifies an inbound webhook really came from the provider, against the raw
   * request bytes and the seller's shared secret.
   *
   * Optional because not every provider signs its webhooks (Webpay sends none
   * at all). `PaymentsService._verifyWebhookSignature` decides per provider
   * whether a missing implementation means "nothing to verify" or "reject" —
   * it must never default to accepting.
   */
  verifySignature?(
    rawBody: string,
    signatureHeader: string,
    secret: string,
  ): boolean;
  /**
   * Gives money back on a completed payment (TRX-2). Optional: a provider
   * without it cannot be refunded through EKORU, and the refund is marked
   * FAILED instead of pretending.
   */
  refund?(args: RefundArgs): Promise<RefundResult>;
  /**
   * Asks the provider what became of a payment the buyer never came back
   * from, before it is expired (Mercado Pago). Optional: Webpay's form simply
   * times out, so there is nothing to ask.
   */
  lookup?(
    args: Omit<ConfirmPaymentArgs, 'rawPayload' | 'externalToken'>,
  ): Promise<ConfirmPaymentResult>;
}
