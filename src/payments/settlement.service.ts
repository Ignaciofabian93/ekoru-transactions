import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  Prisma,
  OrderStatus as DbOrderStatus,
  PaymentStatus as DbPaymentStatus,
  PaymentType as DbPaymentType,
  RefundStatus as DbRefundStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  ServicesClient,
  StoresClient,
  SubgraphError,
  UsersClient,
  type QuotationCharge,
  type StockMovementResult,
} from '../common/clients/index.js';
import { BadRequestError, NotFoundError } from '../common/exceptions/index.js';
import { ProviderRegistry } from './providers/index.js';
import { ChileanPaymentProvider } from '../graphql/enums/index.js';
import { PAYMENT_JOBS, PAYMENT_QUEUE } from './payment-queue.js';

/** Retry policy for jobs that call another service. */
const RETRY = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

/** Refund rows that already claim part of a payment. */
const OPEN_OR_DONE_REFUNDS: DbRefundStatus[] = [
  DbRefundStatus.PENDING,
  DbRefundStatus.PROCESSING,
  DbRefundStatus.COMPLETED,
];

/** A payment can be refunded only after it was charged. */
const REFUNDABLE: DbPaymentStatus[] = [
  DbPaymentStatus.COMPLETED,
  DbPaymentStatus.PARTIALLY_REFUNDED,
];

/** Rounding slack when comparing CLP sums stored as floats. */
const EPSILON = 0.5;

/**
 * What happens after money moves (TRX-2, TRX-3, TRX-6, TRX-9).
 *
 * - **Completed order payment:** the order becomes PAID and the stores
 *   subgraph takes the sold units out of stock. Units that were no longer
 *   there are refunded automatically; a second payment for an order that was
 *   already paid (two tabs) is refunded in full.
 * - **Completed quotation payment:** ekoru-services stamps the quotation paid;
 *   if it refuses (already paid, no longer accepted) the payment is refunded.
 * - **Refunds** are real: the provider is called, and only its answer moves
 *   the refund, the payment and the order. The sum of refunds never exceeds
 *   the payment. A full refund of an order puts its units back in stock.
 *
 * Calls to other services run as retried jobs on the payments queue, each
 * keyed so a retry never repeats a movement.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly providers: ProviderRegistry,
    private readonly stores: StoresClient,
    private readonly services: ServicesClient,
    @InjectQueue(PAYMENT_QUEUE) private readonly queue: Queue,
    private readonly users: UsersClient,
    private readonly config: ConfigService,
  ) {}

  // ─── Completion ───────────────────────────────────────────────────────────

  /** Called once a payment turns COMPLETED. */
  async onCompleted(paymentId: number): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        amount: true,
        orderId: true,
        quotationId: true,
        paymentType: true,
      },
    });
    if (!payment) return;

    if (payment.paymentType === DbPaymentType.ORDER && payment.orderId) {
      const paid = await this.orders.markPaid(payment.orderId);
      if (!paid) {
        // The order was already paid by another payment, or expired before
        // this one went through: the buyer must not be charged twice.
        await this.requestRefund({
          paymentId,
          amount: payment.amount,
          reason:
            'Reembolso automático: la orden ya estaba pagada o había expirado',
        });
        return;
      }
      await this.queue.add(
        PAYMENT_JOBS.stock,
        { kind: 'SALE', orderId: payment.orderId, paymentId },
        { ...RETRY, jobId: `stock-sale-${payment.orderId}` },
      );
    }

    if (
      payment.paymentType === DbPaymentType.QUOTATION &&
      payment.quotationId
    ) {
      await this.queue.add(
        PAYMENT_JOBS.quotation,
        { paymentId },
        { ...RETRY, jobId: `quotation-paid-${paymentId}` },
      );
    }
  }

  /**
   * Job: ekoru-services stamps the quotation paid. A refusal (another payment
   * already paid it, or it is no longer accepted) refunds this payment; any
   * other failure is retried.
   */
  async settleQuotation(paymentId: number): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, amount: true, quotationId: true, status: true },
    });
    if (!payment?.quotationId || payment.status !== DbPaymentStatus.COMPLETED) {
      return;
    }
    let charge: QuotationCharge;
    try {
      charge = await this.services.markQuotationPaid({
        quotationId: payment.quotationId,
        paymentId,
      });
    } catch (error) {
      if (error instanceof SubgraphError && error.code === 'BAD_REQUEST') {
        this.logger.warn(
          `Quotation ${payment.quotationId} refused payment ${paymentId}: ${error.message}`,
        );
        await this.requestRefund({
          paymentId,
          amount: payment.amount,
          reason: `Reembolso automático: ${error.message}`,
        });
        return;
      }
      throw error;
    }
    await this.notifyQuotationPaid(paymentId, charge);
  }

  /**
   * Emails both sides that the quote is paid (WEB-4): every transaction sends
   * one. The job can run again after a retry, so a PaymentTransaction row
   * marks the notice as sent and a rerun stays quiet. Never fails the job.
   */
  private async notifyQuotationPaid(
    paymentId: number,
    charge: QuotationCharge,
  ): Promise<void> {
    try {
      const sent = await this.prisma.paymentTransaction.findFirst({
        where: { paymentId, action: 'QUOTATION_PAID_NOTICE' },
        select: { id: true },
      });
      if (sent) return;
      await this.prisma.paymentTransaction.create({
        data: {
          paymentId,
          action: 'QUOTATION_PAID_NOTICE',
          amount: charge.amount,
          status: 'COMPLETED',
          description: `Aviso de pago de la cotización #${charge.id}`,
        },
      });

      const base = this.config.get<string>('webAppBaseUrl');
      const shared = {
        type: 'PAYMENT_RECEIVED' as const,
        stage: 'IN_PROCESS' as const,
        reference: `Cotización #${charge.id}`,
        summary: charge.title,
        amount: charge.amount,
        currency: charge.currency,
        detailUrl: base ? `${base}/profile/quotes` : null,
        relatedId: String(charge.id),
      };
      await Promise.all([
        this.users.notifyTransaction(charge.clientId, {
          ...shared,
          role: 'BUYER',
          note: 'Pagaste la cotización. El proveedor ya fue avisado.',
        }),
        this.users.notifyTransaction(charge.providerId, {
          ...shared,
          role: 'SELLER',
          note: 'El cliente pagó la cotización. Ya puedes coordinar el servicio.',
        }),
      ]);
    } catch (error) {
      this.logger.error(
        `Quote paid notice for payment ${paymentId} failed`,
        error,
      );
    }
  }

  // ─── Stock ────────────────────────────────────────────────────────────────

  /**
   * Job: takes an order's store units out of stock once it is paid (TRX-3).
   * What stores did is recorded on the payment (action STOCK); units that
   * were no longer there are refunded at their order price, the whole payment
   * when nothing could be taken. Applied once per order on both sides.
   */
  async takeStock({
    orderId,
    paymentId,
  }: {
    orderId: number;
    paymentId: number;
  }): Promise<void> {
    const recorded = await this.stockRecord(paymentId);
    if (recorded) return;

    const lines = await this.storeLines(orderId);
    if (!lines.length) return;

    const result = await this.stores.adjustStock({
      reference: `order:${orderId}:sale`,
      kind: 'SALE',
      items: lines.map((l) => ({
        storeProductId: l.storeProductId,
        quantity: l.quantity,
      })),
    });
    await this.prisma.paymentTransaction.create({
      data: {
        paymentId,
        action: 'STOCK',
        status: result.complete ? 'COMPLETED' : 'PARTIAL',
        description: result.complete
          ? 'Stock descontado'
          : 'Stock insuficiente para parte de la orden',
        metadata: result as unknown as Prisma.InputJsonValue,
      },
    });
    if (result.complete) return;

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { amount: true },
    });
    const nothingTaken = result.items.every((i) => i.applied === 0);
    const priceOf = new Map(lines.map((l) => [l.storeProductId, l.price]));
    const short = result.items.reduce(
      (sum, i) =>
        sum + (i.requested - i.applied) * (priceOf.get(i.storeProductId) ?? 0),
      0,
    );
    const amount = nothingTaken ? (payment?.amount ?? short) : short;
    if (amount > 0) {
      await this.requestRefund({
        paymentId,
        amount,
        reason: 'Reembolso automático: sin stock para parte de la orden',
      });
    }
  }

  /** Job: puts a fully refunded order's units back in stock. */
  async restock({
    orderId,
    paymentId,
  }: {
    orderId: number;
    paymentId: number;
  }): Promise<void> {
    const recorded = await this.stockRecord(paymentId);
    const taken = (recorded?.items ?? []).filter((i) => i.applied > 0);
    if (!taken.length) return;
    await this.stores.adjustStock({
      reference: `order:${orderId}:restock`,
      kind: 'RESTOCK',
      items: taken.map((i) => ({
        storeProductId: i.storeProductId,
        quantity: i.applied,
      })),
    });
  }

  private async stockRecord(
    paymentId: number,
  ): Promise<StockMovementResult | null> {
    const row = await this.prisma.paymentTransaction.findFirst({
      where: { paymentId, action: 'STOCK' },
      orderBy: { createdAt: 'asc' },
      select: { metadata: true },
    });
    return (row?.metadata as unknown as StockMovementResult) ?? null;
  }

  private async storeLines(orderId: number) {
    const items = await this.prisma.orderItem.findMany({
      where: { orderId, storeProductId: { not: null } },
      select: { storeProductId: true, quantity: true, price: true },
    });
    return items.map((i) => ({
      storeProductId: i.storeProductId!,
      quantity: i.quantity,
      price: i.price,
    }));
  }

  // ─── Refunds ──────────────────────────────────────────────────────────────

  /**
   * Opens a refund and queues the provider call (TRX-2). Refunds are capped:
   * what earlier refunds claimed plus this one may not exceed the payment. The
   * payment row is locked while checking, so two refunds at once cannot both
   * pass the cap.
   */
  async requestRefund({
    paymentId,
    amount,
    reason,
    requestedBy,
  }: {
    paymentId: number;
    amount: number;
    reason: string;
    /** Admin id for a manual refund; empty for an automatic one. */
    requestedBy?: string;
  }) {
    if (!(amount > 0)) {
      throw new BadRequestError(
        'El monto del reembolso debe ser mayor que cero',
      );
    }
    const refund = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, amount: true, status: true },
      });
      if (!payment) throw new NotFoundError('Pago no encontrado');
      if (!REFUNDABLE.includes(payment.status)) {
        throw new BadRequestError(
          'Solo se pueden reembolsar pagos completados',
        );
      }
      const { _sum } = await tx.paymentRefund.aggregate({
        where: { paymentId, status: { in: OPEN_OR_DONE_REFUNDS } },
        _sum: { amount: true },
      });
      const remaining = payment.amount - (_sum.amount ?? 0);
      if (amount > remaining + EPSILON) {
        throw new BadRequestError(
          `El reembolso supera lo que queda por devolver (${Math.max(remaining, 0)})`,
        );
      }
      const created = await tx.paymentRefund.create({
        data: { paymentId, amount, reason },
        select: {
          id: true,
          paymentId: true,
          amount: true,
          reason: true,
          status: true,
          createdAt: true,
        },
      });
      await tx.paymentTransaction.create({
        data: {
          paymentId,
          action: 'REFUND_REQUESTED',
          amount,
          status: DbRefundStatus.PENDING,
          description: reason,
          createdBy: requestedBy ?? 'system',
        },
      });
      return created;
    });
    await this.queue.add(
      PAYMENT_JOBS.refund,
      { refundId: refund.id },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3_000 },
        jobId: `refund-${refund.id}`,
      },
    );
    return refund;
  }

  /**
   * Job: asks the provider to give the money back. Only the provider's answer
   * moves state: approved → refund COMPLETED, payment REFUNDED or
   * PARTIALLY_REFUNDED, order REFUNDED on a full refund (and its units back in
   * stock); refused → refund FAILED. A network error throws, so the queue
   * retries; `failRefund` marks it FAILED after the last attempt.
   */
  async executeRefund(refundId: number): Promise<void> {
    const refund = await this.prisma.paymentRefund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        amount: true,
        status: true,
        payment: {
          select: {
            id: true,
            amount: true,
            externalId: true,
            externalToken: true,
            paymentProvider: true,
            chileanConfigId: true,
            orderId: true,
          },
        },
      },
    });
    if (
      !refund ||
      (refund.status !== DbRefundStatus.PENDING &&
        refund.status !== DbRefundStatus.PROCESSING)
    ) {
      return;
    }
    const { payment } = refund;
    await this.prisma.paymentRefund.update({
      where: { id: refundId },
      data: { status: DbRefundStatus.PROCESSING },
    });

    // Same values as the GraphQL enum the registry is keyed on.
    const adapter = this.providers.for(
      payment.paymentProvider as unknown as ChileanPaymentProvider,
    );
    if (typeof adapter.refund !== 'function') {
      await this.finishFailed(
        refundId,
        payment.id,
        `${payment.paymentProvider} no permite reembolsos desde EKORU`,
      );
      return;
    }
    const config = await this.prisma.chileanPaymentConfig.findUnique({
      where: { id: payment.chileanConfigId },
    });
    if (!config) {
      await this.finishFailed(
        refundId,
        payment.id,
        'Configuración no encontrada',
      );
      return;
    }

    const result = await adapter.refund({
      paymentId: payment.id,
      refundId,
      externalId: payment.externalId,
      externalToken: payment.externalToken,
      amount: refund.amount,
      config: {
        environment: config.environment,
        merchantId: config.merchantId,
        apiKey: config.apiKey,
        secretKey: config.secretKey,
      },
    });
    if (!result.ok) {
      await this.finishFailed(
        refundId,
        payment.id,
        'El proveedor rechazó el reembolso',
        result.raw,
      );
      return;
    }

    await this.prisma.paymentRefund.update({
      where: { id: refundId },
      data: {
        status: DbRefundStatus.COMPLETED,
        externalId: result.externalRefundId,
        processedAt: new Date(),
      },
    });
    const { _sum } = await this.prisma.paymentRefund.aggregate({
      where: { paymentId: payment.id, status: DbRefundStatus.COMPLETED },
      _sum: { amount: true },
    });
    const full = (_sum.amount ?? 0) >= payment.amount - EPSILON;
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: full
          ? DbPaymentStatus.REFUNDED
          : DbPaymentStatus.PARTIALLY_REFUNDED,
        refundedAt: new Date(),
      },
    });
    await this.prisma.paymentTransaction.create({
      data: {
        paymentId: payment.id,
        action: 'REFUND',
        amount: refund.amount,
        status: DbRefundStatus.COMPLETED,
        description: full ? 'Reembolso total' : 'Reembolso parcial',
        metadata: result.raw as Prisma.InputJsonValue,
      },
    });

    if (payment.orderId) {
      await this.orders.markRefunded({
        orderId: payment.orderId,
        full,
        amount: refund.amount,
      });
      if (full) {
        await this.queue.add(
          PAYMENT_JOBS.stock,
          { kind: 'RESTOCK', orderId: payment.orderId, paymentId: payment.id },
          { ...RETRY, jobId: `stock-restock-${payment.orderId}` },
        );
      }
    }
  }

  /** Marks a refund FAILED after its last attempt threw. */
  async failRefund(refundId: number, reason: string): Promise<void> {
    const refund = await this.prisma.paymentRefund.findUnique({
      where: { id: refundId },
      select: { paymentId: true, status: true },
    });
    if (!refund || refund.status === DbRefundStatus.COMPLETED) return;
    await this.finishFailed(refundId, refund.paymentId, reason);
  }

  private async finishFailed(
    refundId: number,
    paymentId: number,
    reason: string,
    raw?: Record<string, unknown>,
  ): Promise<void> {
    this.logger.error(`Refund ${refundId} failed: ${reason}`);
    await this.prisma.paymentRefund.update({
      where: { id: refundId },
      data: { status: DbRefundStatus.FAILED },
    });
    await this.prisma.paymentTransaction.create({
      data: {
        paymentId,
        action: 'REFUND',
        status: DbRefundStatus.FAILED,
        description: reason,
        ...(raw && { metadata: raw as Prisma.InputJsonValue }),
      },
    });
  }

  // ─── Expiry (TRX-9) ───────────────────────────────────────────────────────

  /**
   * Job: abandoned checkouts. Payments still pending or processing after the
   * window become EXPIRED, and orders still waiting for payment are CANCELED
   * (which tells both parties). Webpay's own form times out after about ten
   * minutes, so a window of an hour never cuts off a buyer who is paying.
   */
  async expireStale(windowMinutes: number): Promise<{
    payments: number;
    orders: number;
  }> {
    const before = new Date(Date.now() - windowMinutes * 60_000);
    const { count: payments } = await this.prisma.payment.updateMany({
      where: {
        status: { in: [DbPaymentStatus.PENDING, DbPaymentStatus.PROCESSING] },
        createdAt: { lt: before },
      },
      data: {
        status: DbPaymentStatus.EXPIRED,
        failureReason: 'Expirado sin confirmación del proveedor',
      },
    });
    const stale = await this.prisma.order.findMany({
      where: {
        status: DbOrderStatus.PENDING_PAYMENT,
        createdAt: { lt: before },
      },
      select: { id: true },
      take: 500,
    });
    for (const { id } of stale) await this.orders.markCanceled(id);
    if (payments || stale.length) {
      this.logger.log(
        `Expired ${payments} payment(s) and canceled ${stale.length} unpaid order(s)`,
      );
    }
    return { payments, orders: stale.length };
  }
}
