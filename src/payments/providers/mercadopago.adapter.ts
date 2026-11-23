import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalServerError } from '../../common/exceptions/index.js';
import {
  MercadoPagoApi,
  MercadoPagoApiError,
  type MercadoPagoOrder,
  type MercadoPagoOrderPayment,
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

/** Mercado Pago payment status (Payments API) → the canonical one. */
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

/** Orders API order status → the canonical one (TRX-24). */
export function mapMercadoPagoOrderStatus(
  status: string | undefined,
  detail: string | undefined,
): ConfirmPaymentResult['status'] {
  switch (status) {
    case 'processed':
      // processed/accredited is paid; processed/partially_refunded was paid
      // first. processed/refunded, like `refunded` below, only follows a
      // payment that already settled ours.
      return detail === 'refunded' ? 'PROCESSING' : 'COMPLETED';
    case 'failed':
      return 'FAILED';
    // Also an order that expired unpaid.
    case 'canceled':
    case 'cancelled':
      return 'CANCELLED';
    case 'expired':
      return 'EXPIRED';
    // created, processing, action_required; refunded and charged_back.
    default:
      return 'PROCESSING';
  }
}

/**
 * Whether a Payment's `externalId` is an Orders API order (`ORD01…`, TRX-24)
 * rather than a preference (`<collector id>-<uuid>`). Each payment is read
 * and refunded through the API it was created with.
 */
export function isMercadoPagoOrderId(
  externalId: string | null | undefined,
): externalId is string {
  return typeof externalId === 'string' && /^ORD[0-9A-Z]+$/i.test(externalId);
}

/** An amount as the decimal string the Orders API takes; CLP has no cents. */
export function mercadoPagoAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** A decimal string from the Orders API as a number; 0 when absent. */
const amountOf = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Refund statuses that mean the money is not going back. */
const REFUND_FAILED = new Set(['failed', 'rejected', 'canceled', 'cancelled']);

/** The order's payment that went through, else its latest attempt. */
function paidPayment(
  order: MercadoPagoOrder,
): MercadoPagoOrderPayment | undefined {
  const payments = order.transactions?.payments ?? [];
  return (
    payments.find(
      (p) =>
        p.status_detail === 'accredited' ||
        p.status === 'processed' ||
        p.status === 'approved',
    ) ?? payments[payments.length - 1]
  );
}

/** What has been given back on an order so far. */
function refundedOn(order: MercadoPagoOrder): number {
  const payments = order.transactions?.payments ?? [];
  if (payments.some((p) => p.refunded_amount != null)) {
    return payments.reduce((sum, p) => sum + amountOf(p.refunded_amount), 0);
  }
  return (order.transactions?.refunds ?? [])
    .filter((r) => !REFUND_FAILED.has(r.status ?? ''))
    .reduce((sum, r) => sum + amountOf(r.amount), 0);
}

/** Adds our payment id to a return URL, so the return finds it without Mercado Pago's help. */
function withPaymentHint(url: string, paymentId: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('ekoru_payment', String(paymentId));
    return parsed.toString();
  } catch {
    return url;
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
 * New checkouts are Orders API orders (`/v1/orders`) when
 * `MERCADOPAGO_CHECKOUT_API=orders`, else preferences (TRX-24). A payment is
 * then always read and refunded through the API it was created with, told
 * apart by its `externalId` (`isMercadoPagoOrderId`), so switching the
 * setting never strands a payment made before.
 *
 * Nothing a browser or a webhook says is taken at face value: an order is
 * read back by the id stored when it was created, a preference's payment from
 * `/v1/payments`, and either must carry this payment's `external_reference`
 * and amount.
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
    // The checkout stops accepting payments a little before the expiry
    // sweep gives up on the Payment, so nobody pays for an expired order.
    const windowMin = this.config.get<number>(
      'payments.expireAfterMinutes',
      60,
    );
    const payableMinutes = Math.max(10, windowMin - 5);

    if (this.config.get<string>('mercadoPago.checkoutApi') === 'orders') {
      return this.createOrder(args, { accessToken, fee, payableMinutes });
    }

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
        expiration_date_to: new Date(
          Date.now() + payableMinutes * 60_000,
        ).toISOString(),
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
   * The buyer is back from Checkout Pro. An order is read by its stored id,
   * whatever the query says. For a preference the query names the Mercado
   * Pago payment (`payment_id` / `collection_id`); when it does not (the
   * buyer left without paying), the payment is looked up by our reference.
   */
  async confirm(args: ConfirmPaymentArgs): Promise<ConfirmPaymentResult> {
    if (isMercadoPagoOrderId(args.externalId)) return this.readOrder(args);
    const value =
      args.rawPayload['payment_id'] ?? args.rawPayload['collection_id'];
    const named =
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    if (NO_PAYMENT.has(named)) return this.lookup(args);
    return this.resolve({ ...args, providerPaymentId: named });
  }

  /** What became of this payment at Mercado Pago: its order, or the newest payment with its reference. */
  async lookup(
    args: Omit<ConfirmPaymentArgs, 'rawPayload' | 'externalToken'>,
  ): Promise<ConfirmPaymentResult> {
    if (isMercadoPagoOrderId(args.externalId)) return this.readOrder(args);
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

  /**
   * Reads what a return or a webhook pointed at and checks it is this
   * payment's. An order is read by the id we stored, not by what the
   * notification named.
   */
  async resolve(
    args: Omit<ConfirmPaymentArgs, 'rawPayload' | 'externalToken'> & {
      providerPaymentId: string;
    },
  ): Promise<ConfirmPaymentResult> {
    if (isMercadoPagoOrderId(args.externalId)) return this.readOrder(args);
    const payment = await this.api.getPayment({
      accessToken: this.token(args.config),
      paymentId: args.providerPaymentId,
    });
    return this.fromProviderPayment(payment, args);
  }

  /**
   * Which of our payments a Mercado Pago payment belongs to, from its
   * reference. One this store's token cannot find (404) is not ours.
   */
  async identify({
    providerPaymentId,
    config,
  }: {
    providerPaymentId: string;
    config: InitiatePaymentArgs['config'];
  }): Promise<number | null> {
    try {
      const payment = await this.api.getPayment({
        accessToken: this.token(config),
        paymentId: providerPaymentId,
      });
      return paymentIdFromReference(payment.external_reference);
    } catch (error) {
      // Anything else may pass: the webhook answers 500 and comes back.
      if (error instanceof MercadoPagoApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * A paid charge as Mercado Pago sees it now, for what can happen after the
   * payment (TRX-22): refunds made from the store's account, disputes. An
   * order is read by its id (`externalId`); a preference's charge by its
   * payment id. `status` keeps the Payments API's words (`charged_back`,
   * `in_mediation`) for both.
   */
  async inspect({
    providerPaymentId,
    externalId,
    config,
  }: {
    providerPaymentId: string;
    externalId?: string | null;
    config: InitiatePaymentArgs['config'];
  }): Promise<{
    paymentId: number | null;
    status: string;
    refunded: number;
    raw: Record<string, unknown>;
  }> {
    if (isMercadoPagoOrderId(externalId)) {
      const order = await this.api.getOrder({
        accessToken: this.token(config),
        orderId: externalId,
      });
      const status = order.transactions?.chargebacks?.length
        ? 'charged_back'
        : /mediation/.test(order.status_detail ?? '')
          ? 'in_mediation'
          : (order.status ?? 'unknown');
      return {
        paymentId: paymentIdFromReference(order.external_reference),
        status,
        refunded: refundedOn(order),
        raw: this.orderRaw(order),
      };
    }
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
    if (isMercadoPagoOrderId(args.externalId)) {
      return this.refundOrder({ ...args, externalId: args.externalId });
    }
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
      idempotencyKey: this.refundKey(args),
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

  // ─── Orders API (TRX-24) ──────────────────────────────────────────────────

  private async createOrder(
    args: InitiatePaymentArgs,
    {
      accessToken,
      fee,
      payableMinutes,
    }: { accessToken: string; fee: number; payableMinutes: number },
  ): Promise<InitiatePaymentResult> {
    const amount = mercadoPagoAmount(args.amount);
    // Mercado Pago's return should carry our external_reference; the hint
    // finds the payment even if it does not.
    const returnUrl = withPaymentHint(args.returnUrl, args.paymentId);
    const order = await this.api.createOrder({
      accessToken,
      idempotencyKey: `ekoru-order-${args.paymentId}`,
      body: {
        type: 'online',
        // Checkout Pro's page takes the payment: `manual` is the only mode
        // it accepts.
        processing_mode: 'manual',
        // Approved or rejected at once, never pending (the preference's
        // `binary_mode`): an order is either paid or not when the buyer
        // comes back.
        capture_mode: 'automatic',
        external_reference: mercadoPagoReference(args.paymentId),
        total_amount: amount,
        description: args.description.slice(0, 100),
        ...(fee > 0 ? { marketplace_fee: mercadoPagoAmount(fee) } : {}),
        expiration_time: `PT${payableMinutes}M`,
        items: [
          {
            title: args.description.slice(0, 100),
            unit_price: amount,
            quantity: 1,
            external_code: String(args.orderId || args.paymentId),
          },
        ],
        config: {
          online: {
            success_url: returnUrl,
            failure_url: returnUrl,
            pending_url: returnUrl,
            auto_return: 'approved',
          },
        },
      },
    });
    // Every later read and refund keys on the order id's shape.
    if (!isMercadoPagoOrderId(order.id) || !order.checkout_url) {
      this.logger.error(
        `Mercado Pago order for payment ${args.paymentId} came back without an order id or checkout_url (id: ${String(order.id)})`,
      );
      throw new InternalServerError(
        'Mercado Pago no devolvió el enlace de pago',
      );
    }
    return {
      externalId: order.id,
      externalToken: null,
      redirect: { kind: 'EXTERNAL', url: order.checkout_url },
    };
  }

  private async readOrder(args: {
    paymentId: number;
    amount: number;
    externalId: string;
    config: InitiatePaymentArgs['config'];
  }): Promise<ConfirmPaymentResult> {
    const order = await this.api.getOrder({
      accessToken: this.token(args.config),
      orderId: args.externalId,
    });
    return this.fromOrder(order, args);
  }

  /**
   * Gives back an order's money. The whole of an untouched charge is
   * Mercado Pago's full refund; anything else names the payment and amount.
   */
  private async refundOrder(
    args: RefundArgs & { externalId: string },
  ): Promise<RefundResult> {
    const accessToken = this.token(args.config);
    const order = await this.api.getOrder({
      accessToken,
      orderId: args.externalId,
    });
    const paid = paidPayment(order);
    if (!paid?.id) {
      return {
        ok: false,
        externalRefundId: null,
        raw: {
          reason: 'mercadopago_order_not_paid',
          paymentId: args.paymentId,
          ...this.orderRaw(order),
        },
      };
    }
    const charged = amountOf(paid.amount ?? order.total_amount);
    const full =
      amountOf(paid.refunded_amount) === 0 &&
      Math.round(args.amount) >= Math.round(charged);
    const result = await this.api.refundOrder({
      accessToken,
      orderId: args.externalId,
      ...(full
        ? {}
        : {
            transactions: [
              { id: paid.id, amount: mercadoPagoAmount(args.amount) },
            ],
          }),
      idempotencyKey: this.refundKey(args),
    });
    const refunds = (result.transactions?.refunds ?? []).filter(
      (r) => !r.transaction_id || r.transaction_id === paid.id,
    );
    const refund = refunds[refunds.length - 1];
    return {
      // A 2xx means Mercado Pago took it; only a refund it reports as
      // failed is not going back.
      ok: !refund || !REFUND_FAILED.has(refund.status ?? ''),
      externalRefundId: refund?.id ?? null,
      raw: { ...this.orderRaw(result), refund: refund ?? null },
    };
  }

  private fromOrder(
    order: MercadoPagoOrder,
    expected: { paymentId: number; amount: number },
  ): ConfirmPaymentResult {
    const raw = this.orderRaw(order);
    if (
      paymentIdFromReference(order.external_reference) !== expected.paymentId
    ) {
      this.logger.warn(
        `Mercado Pago order ${order.id} does not belong to payment ${expected.paymentId}`,
      );
      return {
        status: 'PROCESSING',
        raw: { ...raw, reason: 'reference_mismatch' },
      };
    }
    const status = mapMercadoPagoOrderStatus(order.status, order.status_detail);
    const paid = paidPayment(order);
    const ids = paid?.id ? { providerPaymentId: paid.id } : {};
    // What the order asks for; the buyer's installment interest may make
    // the paid amount larger.
    const charged = amountOf(order.total_amount ?? paid?.amount);
    if (
      status === 'COMPLETED' &&
      Math.round(charged) !== Math.round(expected.amount)
    ) {
      this.logger.error(
        `Mercado Pago order ${order.id} charged ${charged}, payment ${expected.paymentId} expected ${expected.amount}`,
      );
      return {
        status: 'FAILED',
        raw: { ...raw, error: 'El monto cobrado no coincide con la orden' },
        ...ids,
      };
    }
    return { status, raw, ...ids };
  }

  /** What is kept of an order for the audit trail. */
  private orderRaw(order: MercadoPagoOrder): Record<string, unknown> {
    const paid = paidPayment(order);
    return {
      order_id: order.id,
      status: order.status ?? null,
      status_detail: order.status_detail ?? null,
      external_reference: order.external_reference ?? null,
      total_amount: order.total_amount ?? null,
      total_paid_amount: order.total_paid_amount ?? null,
      marketplace_fee: order.marketplace_fee ?? null,
      payment_id: paid?.id ?? null,
      payment_status: paid?.status ?? null,
      payment_status_detail: paid?.status_detail ?? null,
      refunded: refundedOn(order),
    };
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

  /** Makes a retried refund call idempotent: one key per refund row. */
  private refundKey(args: RefundArgs): string {
    return `ekoru-refund-${args.refundId ?? `${args.paymentId}-${args.amount}`}`;
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
   * Where Mercado Pago posts a preference's webhook. `ekoru_payment` is only
   * a hint for finding the store's token; the payment read back with it must
   * still carry our reference. Orders notify the URL set in the
   * application's Webhooks screen (topic "Order (Mercado Pago)").
   */
  private notificationUrl(paymentId: number): string {
    const base = this.config.get<string>('gatewayBaseUrl');
    if (!base) throw new InternalServerError('GATEWAY_BASE_URL no configurado');
    return `${base}/payments/webhook/mercadopago?source_news=webhooks&ekoru_payment=${paymentId}`;
  }
}
