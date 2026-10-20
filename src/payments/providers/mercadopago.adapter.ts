import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalServerError } from '../../common/exceptions/index.js';
import {
  MercadoPagoApi,
  type MercadoPagoPayment,
} from '../mercadopago/mercadopago.api.js';
import type {
  ConfirmPaymentArgs,
  ConfirmPaymentResult,
  InitiatePaymentArgs,
  InitiatePaymentResult,
  ProviderAdapter,
  RefundArgs,
  RefundResult,
} from './provider-adapter.js';

/** `external_reference` of a Payment; how a Mercado Pago charge is tied back to it. */
export const mercadoPagoReference = (paymentId: number) =>
  `ekoru-pay-${paymentId}`;

/** The Payment id inside an `external_reference`, or null when it is not ours. */
export function paymentIdFromReference(reference: unknown): number | null {
  if (typeof reference !== 'string') return null;
  const match = /^ekoru-pay-(\d+)$/.exec(reference);
  return match ? Number(match[1]) : null;
}

/** Mercado Pago payment status → the canonical one. */
export function mapMercadoPagoStatus(
  status: string | undefined,
): ConfirmPaymentResult['status'] {
  switch (status) {
    case 'approved':
      return 'COMPLETED';
    case 'rejected':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    // pending, in_process, authorized, in_mediation; refunded and
    // charged_back only follow an approval, which already settled the payment.
    default:
      return 'PROCESSING';
  }
}

/** Never a real payment id: what the return carries when the buyer left without paying. */
const NO_PAYMENT = new Set(['', 'null', 'undefined']);

/**
 * Mercado Pago Checkout Pro, marketplace split 1:1 (TRX-5).
 *
 * Every call is made with the receiving store's own access token, obtained
 * when it connected its account (MercadoPagoConnectService) and kept in
 * `ChileanPaymentConfig.secretKey`. The buyer pays the store; EKORU's
 * commission goes in `marketplace_fee` and Mercado Pago credits it to
 * EKORU's account at source. Payments to EKORU itself (memberships) use
 * EKORU's own access token the same way, with no fee.
 *
 * Nothing a browser or a webhook says is taken at face value: the status is
 * always read back from `/v1/payments` and must carry this payment's
 * `external_reference` and amount.
 */
@Injectable()
export class MercadoPagoAdapter implements ProviderAdapter {
  private readonly logger = new Logger(MercadoPagoAdapter.name);

  constructor(
    private readonly config: ConfigService,
    private readonly api: MercadoPagoApi,
  ) {}

  async initiate(args: InitiatePaymentArgs): Promise<InitiatePaymentResult> {
    const accessToken = this.token(args.config);
    const fee = Math.max(0, Math.round(args.platformFee ?? 0));
    // The preference stops accepting payments a little before the expiry
    // sweep gives up on the Payment, so nobody pays for an expired order.
    const windowMin = this.config.get<number>(
      'payments.expireAfterMinutes',
      60,
    );
    const expiresAt = new Date(
      Date.now() + Math.max(10, windowMin - 5) * 60_000,
    );

    const preference = await this.api.createPreference({
      accessToken,
      idempotencyKey: `ekoru-pref-${args.paymentId}`,
      body: {
        items: [
          {
            id: String(args.orderId || args.paymentId),
            title: args.description.slice(0, 100),
            quantity: 1,
            unit_price: args.amount,
            currency_id: args.currency,
          },
        ],
        external_reference: mercadoPagoReference(args.paymentId),
        metadata: { ekoru_payment_id: args.paymentId },
        ...(fee > 0 ? { marketplace_fee: fee } : {}),
        // Approved or rejected at once, never "pending": an order is either
        // paid or not when the buyer comes back.
        binary_mode: true,
        expires: true,
        expiration_date_to: expiresAt.toISOString(),
        // Mercado Pago appends collection_id, status, external_reference,
        // preference_id… to each URL.
        back_urls: {
          success: args.returnUrl,
          failure: args.returnUrl,
          pending: args.returnUrl,
        },
        auto_return: 'approved',
        notification_url: this.notificationUrl(args.paymentId),
      },
    });

    return {
      externalId: preference.id,
      externalToken: null,
      // `sandbox_init_point` is deprecated: test accounts use init_point too.
      redirect: { kind: 'EXTERNAL', url: preference.init_point },
    };
  }

  /**
   * The buyer is back from Checkout Pro. The query names the Mercado Pago
   * payment (`payment_id` / `collection_id`); when it does not (the buyer
   * left without paying), the payment is looked up by our reference.
   */
  async confirm(args: ConfirmPaymentArgs): Promise<ConfirmPaymentResult> {
    const value =
      args.rawPayload['payment_id'] ?? args.rawPayload['collection_id'];
    const named =
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    if (NO_PAYMENT.has(named)) return this.lookup(args);
    return this.resolve({ ...args, providerPaymentId: named });
  }

  /** What became of this payment at Mercado Pago, found by its reference. */
  async lookup(
    args: Omit<ConfirmPaymentArgs, 'rawPayload' | 'externalToken'>,
  ): Promise<ConfirmPaymentResult> {
    const found = await this.api.findPaymentByReference({
      accessToken: this.token(args.config),
      externalReference: mercadoPagoReference(args.paymentId),
    });
    if (!found) {
      return {
        status: 'PROCESSING',
        raw: { reason: 'mercadopago_no_payment_yet' },
      };
    }
    return this.fromProviderPayment(found, args);
  }

  /** Reads one Mercado Pago payment (from a return or a webhook) and checks it is this one. */
  async resolve(
    args: Omit<ConfirmPaymentArgs, 'rawPayload' | 'externalToken'> & {
      providerPaymentId: string;
    },
  ): Promise<ConfirmPaymentResult> {
    const payment = await this.api.getPayment({
      accessToken: this.token(args.config),
      paymentId: args.providerPaymentId,
    });
    return this.fromProviderPayment(payment, args);
  }

  /** Which of our payments a Mercado Pago payment belongs to, from its reference. */
  async identify({
    providerPaymentId,
    config,
  }: {
    providerPaymentId: string;
    config: InitiatePaymentArgs['config'];
  }): Promise<number | null> {
    const payment = await this.api.getPayment({
      accessToken: this.token(config),
      paymentId: providerPaymentId,
    });
    return paymentIdFromReference(payment.external_reference);
  }

  /**
   * A paid charge as Mercado Pago sees it now, for what can happen after the
   * payment (TRX-22): refunds made from the store's account, disputes.
   */
  async inspect({
    providerPaymentId,
    config,
  }: {
    providerPaymentId: string;
    config: InitiatePaymentArgs['config'];
  }): Promise<{
    paymentId: number | null;
    status: string;
    refunded: number;
    raw: Record<string, unknown>;
  }> {
    const payment = await this.api.getPayment({
      accessToken: this.token(config),
      paymentId: providerPaymentId,
    });
    return {
      paymentId: paymentIdFromReference(payment.external_reference),
      status: payment.status,
      refunded: payment.transaction_amount_refunded ?? 0,
      raw: {
        id: payment.id,
        status: payment.status,
        status_detail: payment.status_detail ?? null,
        transaction_amount: payment.transaction_amount,
        transaction_amount_refunded: payment.transaction_amount_refunded ?? 0,
      },
    };
  }

  /** Refunds (all or part of) a charge; Mercado Pago returns EKORU's fee share proportionally. */
  async refund(args: RefundArgs): Promise<RefundResult> {
    if (!args.externalToken) {
      return {
        ok: false,
        externalRefundId: null,
        raw: {
          reason: 'mercadopago_missing_payment_id',
          paymentId: args.paymentId,
        },
      };
    }
    const refund = await this.api.refund({
      accessToken: this.token(args.config),
      paymentId: args.externalToken,
      amount: args.amount,
      idempotencyKey: `ekoru-refund-${args.refundId ?? `${args.paymentId}-${args.amount}`}`,
    });
    return {
      // in_process: Mercado Pago accepted it and is moving the money.
      ok: refund.status === 'approved' || refund.status === 'in_process',
      externalRefundId: refund.id != null ? String(refund.id) : null,
      raw: refund as unknown as Record<string, unknown>,
    };
  }

  /**
   * Mercado Pago webhooks only name a resource; PaymentsService verifies the
   * signature and calls `resolve` with the store's token. Nothing to read
   * from the payload alone.
   */
  handleWebhook(): Promise<ConfirmPaymentResult> {
    return Promise.resolve({
      status: 'PROCESSING',
      raw: { note: 'mercadopago_resolved_by_api' },
    });
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private fromProviderPayment(
    payment: MercadoPagoPayment,
    expected: { paymentId: number; amount: number },
  ): ConfirmPaymentResult {
    const raw = {
      id: payment.id,
      status: payment.status,
      status_detail: payment.status_detail ?? null,
      external_reference: payment.external_reference ?? null,
      transaction_amount: payment.transaction_amount,
      collector_id: payment.collector_id ?? null,
      date_approved: payment.date_approved ?? null,
    };
    if (
      paymentIdFromReference(payment.external_reference) !== expected.paymentId
    ) {
      this.logger.warn(
        `Mercado Pago payment ${payment.id} does not belong to payment ${expected.paymentId}`,
      );
      return {
        status: 'PROCESSING',
        raw: { ...raw, reason: 'reference_mismatch' },
      };
    }
    const status = mapMercadoPagoStatus(payment.status);
    if (
      status === 'COMPLETED' &&
      Math.round(payment.transaction_amount) !== Math.round(expected.amount)
    ) {
      this.logger.error(
        `Mercado Pago payment ${payment.id} charged ${payment.transaction_amount}, payment ${expected.paymentId} expected ${expected.amount}`,
      );
      return {
        status: 'FAILED',
        raw: { ...raw, error: 'El monto cobrado no coincide con la orden' },
        providerPaymentId: String(payment.id),
      };
    }
    return { status, raw, providerPaymentId: String(payment.id) };
  }

  private token(config: InitiatePaymentArgs['config']): string {
    if (!config.secretKey) {
      throw new InternalServerError(
        'La cuenta de Mercado Pago de este vendedor no está conectada',
      );
    }
    return config.secretKey;
  }

  /**
   * Where Mercado Pago posts the webhook. `ekoru_payment` is only a hint for
   * finding the store's token; the payment read back with it must still
   * carry our reference.
   */
  private notificationUrl(paymentId: number): string {
    const base = this.config.get<string>('gatewayBaseUrl');
    if (!base) throw new InternalServerError('GATEWAY_BASE_URL no configurado');
    return `${base}/payments/webhook/mercadopago?source_news=webhooks&ekoru_payment=${paymentId}`;
  }
}
