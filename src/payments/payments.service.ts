import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  NotFoundError,
  BadRequestError,
  InternalServerError,
} from '../common/exceptions/index.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import {
  CreatePaymentInput,
  CreatePaymentConfigInput,
  RefundPaymentInput,
} from './dto/index.js';
import {
  ChileanPaymentProvider,
  OrderStatus,
  PaymentStatus,
  PaymentType,
} from '../graphql/enums/index.js';
import { OrdersService } from '../orders/orders.service.js';
import { ProviderRegistry } from './providers/index.js';

// Queue name constants – used by both service and processor
export const PAYMENT_QUEUE = 'payments';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly providers: ProviderRegistry,
    @InjectQueue(PAYMENT_QUEUE) private readonly paymentQueue: Queue,
  ) {}

  // ─── Payment Config ───────────────────────────────────────────────────────

  async getPaymentConfig(id: number) {
    try {
      const config = await this.prisma.chileanPaymentConfig.findUnique({
        where: { id },
        select: {
          id: true,
          sellerId: true,
          provider: true,
          merchantId: true,
          environment: true,
          isActive: true,
          webhookUrl: true,
          returnUrl: true,
          cancelUrl: true,
          createdAt: true,
          updatedAt: true,
          // apiKey/secretKey are write-only — never expose them.
        },
      });
      if (!config) throw new NotFoundError('Configuración de pago no encontrada');
      return config;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al obtener la configuración de pago:', error);
      throw new InternalServerError('Error al obtener la configuración de pago');
    }
  }

  async getPaymentConfigsBySeller(sellerId: string) {
    try {
      return await this.prisma.chileanPaymentConfig.findMany({
        where: { sellerId },
        select: {
          id: true,
          sellerId: true,
          provider: true,
          merchantId: true,
          environment: true,
          isActive: true,
          webhookUrl: true,
          returnUrl: true,
          cancelUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (error) {
      this.logger.error(
        'Error al obtener configuraciones de pago del vendedor:',
        error,
      );
      throw new InternalServerError(
        'Error al obtener configuraciones de pago del vendedor',
      );
    }
  }

  async createPaymentConfig(input: CreatePaymentConfigInput) {
    try {
      const existing = await this.prisma.chileanPaymentConfig.findUnique({
        where: {
          sellerId_provider: {
            sellerId: input.sellerId,
            provider: input.provider as ChileanPaymentProvider,
          },
        },
      });
      if (existing) {
        throw new BadRequestError(
          `Ya existe una configuración para el proveedor ${input.provider}`,
        );
      }
      return await this.prisma.chileanPaymentConfig.create({
        data: {
          sellerId: input.sellerId,
          provider: input.provider,
          merchantId: input.merchantId,
          apiKey: input.apiKey,
          secretKey: input.secretKey,
          environment: input.environment,
          isActive: input.isActive ?? true,
          webhookUrl: input.webhookUrl,
          returnUrl: input.returnUrl,
          cancelUrl: input.cancelUrl,
          updatedAt: new Date(),
        },
        select: {
          id: true,
          sellerId: true,
          provider: true,
          merchantId: true,
          environment: true,
          isActive: true,
          webhookUrl: true,
          returnUrl: true,
          cancelUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      this.logger.error('Error al crear la configuración de pago:', error);
      throw new InternalServerError('Error al crear la configuración de pago');
    }
  }

  // ─── Payments ─────────────────────────────────────────────────────────────

  async getPayment(id: number) {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id },
        select: PAYMENT_SELECT,
      });
      if (!payment) throw new NotFoundError('Pago no encontrado');
      return this._mapPayment(payment);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al obtener el pago:', error);
      throw new InternalServerError('Error al obtener el pago');
    }
  }

  async getPaymentsByPayer({
    payerId,
    page,
    pageSize,
    status,
  }: {
    payerId: string;
    page: number;
    pageSize: number;
    status?: PaymentStatus;
  }) {
    return this._paginatedPayments({ payerId, status }, page, pageSize);
  }

  async getPaymentsByReceiver({
    receiverId,
    page,
    pageSize,
    status,
  }: {
    receiverId: string;
    page: number;
    pageSize: number;
    status?: PaymentStatus;
  }) {
    return this._paginatedPayments({ receiverId, status }, page, pageSize);
  }

  /**
   * Creates a Payment for an existing PENDING_PAYMENT order and hands the
   * buyer off to the provider.
   *
   * Trust model: buyer comes from the JWT; amount/currency/receiver come
   * from the Order row, never from input. The frontend can't influence the
   * charged amount.
   *
   * The provider call is intentionally **synchronous** — the redirect URL
   * IS the response the user is waiting on. BullMQ is reserved for async
   * reconciliation (webhooks, refunds).
   */
  async createPayment({
    input,
    payerId,
  }: {
    input: CreatePaymentInput;
    payerId: string;
  }) {
    if (!payerId) {
      throw new BadRequestError('Debe iniciar sesión para pagar');
    }

    // 1. Load + validate the order.
    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      select: {
        id: true,
        buyerId: true,
        sellerId: true,
        total: true,
        currency: true,
        status: true,
      },
    });
    if (!order) throw new NotFoundError('Orden no encontrada');
    if (order.buyerId !== payerId) {
      throw new BadRequestError('Esta orden no te pertenece');
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestError(
        `Esta orden no se puede pagar (estado actual: ${order.status})`,
      );
    }

    // 2. Resolve the seller's provider config.
    const config = await this.prisma.chileanPaymentConfig.findFirst({
      where: {
        sellerId: order.sellerId,
        provider: input.provider,
        isActive: true,
      },
    });
    if (!config) {
      throw new BadRequestError(
        `El vendedor no tiene ${input.provider} configurado`,
      );
    }

    // 3. Persist a PENDING Payment row first so we have an id for the
    //    provider's external_reference.
    const payment = await this.prisma.payment.create({
      data: {
        orderId: order.id,
        amount: order.total,
        currency: order.currency,
        paymentProvider: input.provider,
        description: `Orden #${order.id}`,
        payerId,
        receiverId: order.sellerId,
        paymentType: PaymentType.ORDER,
        chileanConfigId: config.id,
        status: PaymentStatus.PROCESSING,
        updatedAt: new Date(),
      },
      select: PAYMENT_SELECT,
    });

    // 4. Hand off to the provider adapter.
    const adapter = this.providers.for(input.provider);
    let initiate: Awaited<ReturnType<typeof adapter.initiate>>;
    try {
      initiate = await adapter.initiate({
        paymentId: payment.id,
        orderId: order.id,
        amount: order.total,
        currency: order.currency,
        description: `Orden Ekoru #${order.id}`,
        returnUrl: input.returnUrl,
        config: {
          environment: config.environment,
          merchantId: config.merchantId,
          apiKey: config.apiKey,
          secretKey: config.secretKey,
        },
      });
    } catch (err) {
      // Flip the Payment to FAILED so the buyer can retry with another method.
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: err instanceof Error ? err.message : 'unknown',
        },
      });
      throw err;
    }

    // 5. Persist the provider's externalId/token.
    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        externalId: initiate.externalId,
        externalToken: initiate.externalToken,
        updatedAt: new Date(),
      },
      select: PAYMENT_SELECT,
    });

    await this.prisma.paymentTransaction.create({
      data: {
        paymentId: payment.id,
        action: 'INITIATE',
        amount: order.total,
        status: PaymentStatus.PROCESSING,
        description: `Pago iniciado con ${input.provider}`,
      },
    });

    return {
      paymentId: String(updated.id),
      provider: input.provider,
      status: updated.status,
      redirect: initiate.redirect,
      payment: this._mapPayment(updated),
    };
  }

  /**
   * Refund a completed payment. Same async pattern as before — refunds
   * happen in the BullMQ queue because they can take seconds with some
   * providers and the user doesn't need to block on them.
   */
  async refundPayment(input: RefundPaymentInput) {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: input.paymentId },
        select: { id: true, amount: true, status: true, paymentProvider: true },
      });
      if (!payment) throw new NotFoundError('Pago no encontrado');
      if (payment.status !== PaymentStatus.COMPLETED) {
        throw new BadRequestError('Solo se pueden reembolsar pagos completados');
      }
      if (input.amount > payment.amount) {
        throw new BadRequestError(
          'El monto del reembolso no puede superar el monto del pago',
        );
      }
      const refund = await this.prisma.paymentRefund.create({
        data: { paymentId: input.paymentId, amount: input.amount, reason: input.reason },
        select: {
          id: true,
          paymentId: true,
          amount: true,
          reason: true,
          status: true,
          createdAt: true,
        },
      });
      await this.paymentQueue.add(
        'process-refund',
        {
          refundId: refund.id,
          paymentId: input.paymentId,
          amount: input.amount,
          provider: payment.paymentProvider,
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
      );
      return refund;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof BadRequestError) {
        throw error;
      }
      this.logger.error('Error al procesar el reembolso:', error);
      throw new InternalServerError('Error al procesar el reembolso');
    }
  }

  // ─── Provider return/webhook handlers (called by gateway) ─────────────────

  /**
   * Called by the gateway's `POST /payments/return/:provider` route after
   * the buyer is redirected back from the provider. The gateway has already
   * authenticated the request as coming from itself (internal secret).
   *
   * For Webpay this is the only commit signal (no webhook). For Khipu and
   * MercadoPago it's informational — the webhook is authoritative.
   */
  async handleProviderReturn({
    provider,
    rawPayload,
  }: {
    provider: ChileanPaymentProvider;
    rawPayload: Record<string, unknown>;
  }): Promise<{ paymentId: number; status: PaymentStatus }> {
    const externalId = this._extractExternalId(provider, rawPayload);
    const payment = await this.prisma.payment.findFirst({
      where: { externalId, paymentProvider: provider },
      select: { id: true, externalId: true, externalToken: true, chileanConfigId: true, orderId: true },
    });
    if (!payment) {
      throw new NotFoundError('No se encontró el pago para este retorno');
    }

    const config = await this.prisma.chileanPaymentConfig.findUnique({
      where: { id: payment.chileanConfigId },
    });
    if (!config) throw new NotFoundError('Configuración no encontrada');

    const adapter = this.providers.for(provider);
    const result = await adapter.confirm({
      paymentId: payment.id,
      externalId: payment.externalId!,
      externalToken: payment.externalToken,
      config: {
        environment: config.environment,
        merchantId: config.merchantId,
        apiKey: config.apiKey,
        secretKey: config.secretKey,
      },
      rawPayload,
    });

    await this._applyTerminalStatus(payment.id, payment.orderId, result.status, result.raw);
    return { paymentId: payment.id, status: this._toPaymentStatus(result.status) };
  }

  /**
   * Called by the gateway's `POST /payments/webhook/:provider` route. The
   * gateway has already verified the provider's signature.
   */
  async handleProviderWebhook({
    provider,
    eventType,
    rawPayload,
  }: {
    provider: ChileanPaymentProvider;
    eventType: string;
    rawPayload: Record<string, unknown>;
  }): Promise<{ paymentId?: number; status?: PaymentStatus }> {
    const externalId = this._extractExternalId(provider, rawPayload);
    const payment = externalId
      ? await this.prisma.payment.findFirst({
          where: { externalId, paymentProvider: provider },
          select: { id: true, orderId: true },
        })
      : null;

    await this.prisma.paymentWebhook.create({
      data: {
        paymentId: payment?.id,
        provider,
        eventType,
        externalId: externalId ?? 'unknown',
        payload: rawPayload as Prisma.InputJsonValue,
        processed: false,
      },
    });

    const adapter = this.providers.for(provider);
    const result = await adapter.handleWebhook(rawPayload);

    if (payment && result.status !== 'PROCESSING') {
      await this._applyTerminalStatus(payment.id, payment.orderId, result.status, result.raw);
      return { paymentId: payment.id, status: this._toPaymentStatus(result.status) };
    }
    return { paymentId: payment?.id };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /**
   * Persists the canonical PaymentStatus + flips the associated Order's
   * status when applicable. Idempotent — calling twice with the same
   * terminal status is a no-op.
   */
  private async _applyTerminalStatus(
    paymentId: number,
    orderId: number | null,
    rawStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'PROCESSING',
    raw: Record<string, unknown>,
  ) {
    const status = this._toPaymentStatus(rawStatus);
    const isTerminal = status !== PaymentStatus.PROCESSING;
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status,
        processedAt: status === PaymentStatus.COMPLETED ? new Date() : undefined,
        failureReason:
          status === PaymentStatus.FAILED || status === PaymentStatus.CANCELLED
            ? typeof raw['error'] === 'string'
              ? (raw['error'] as string)
              : null
            : undefined,
        updatedAt: new Date(),
      },
    });
    await this.prisma.paymentTransaction.create({
      data: {
        paymentId,
        action: 'STATUS',
        status,
        description: `Provider reported ${rawStatus}`,
        metadata: raw as Prisma.InputJsonValue,
      },
    });
    if (orderId && isTerminal) {
      if (status === PaymentStatus.COMPLETED) {
        await this.orders.markPaid(orderId);
      } else if (
        status === PaymentStatus.FAILED ||
        status === PaymentStatus.CANCELLED ||
        status === PaymentStatus.EXPIRED
      ) {
        await this.orders.markCanceled(orderId);
      }
    }
  }

  private _toPaymentStatus(
    raw: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'PROCESSING',
  ): PaymentStatus {
    switch (raw) {
      case 'COMPLETED':
        return PaymentStatus.COMPLETED;
      case 'FAILED':
        return PaymentStatus.FAILED;
      case 'CANCELLED':
        return PaymentStatus.CANCELLED;
      case 'EXPIRED':
        return PaymentStatus.EXPIRED;
      case 'PROCESSING':
        return PaymentStatus.PROCESSING;
    }
  }

  /**
   * Each provider names the order/payment id field differently in its
   * return / webhook payloads. Centralize the extraction here.
   */
  private _extractExternalId(
    provider: ChileanPaymentProvider,
    payload: Record<string, unknown>,
  ): string | undefined {
    switch (provider) {
      case ChileanPaymentProvider.WEBPAY:
        // Webpay return carries `TBK_ORDEN_COMPRA` (the buyOrder we sent)
        // and `token_ws` for the SDK commit. We persisted buyOrder as
        // externalId, so prefer it.
        return (
          (payload['TBK_ORDEN_COMPRA'] as string | undefined) ??
          (payload['buy_order'] as string | undefined)
        );
      case ChileanPaymentProvider.KHIPU:
        return (
          (payload['payment_id'] as string | undefined) ??
          (payload['notification_token'] as string | undefined)
        );
      case ChileanPaymentProvider.MERCADOPAGO:
        return (
          ((payload['data'] as { id?: string } | undefined)?.id) ??
          (payload['preference_id'] as string | undefined) ??
          (payload['external_reference'] as string | undefined)
        );
    }
  }

  private async _paginatedPayments(
    where: { payerId?: string; receiverId?: string; status?: PaymentStatus },
    page: number,
    pageSize: number,
  ) {
    try {
      const { skip, take } = calculatePrismaParams(page, pageSize);
      const filtered = {
        ...(where.payerId && { payerId: where.payerId }),
        ...(where.receiverId && { receiverId: where.receiverId }),
        ...(where.status && { status: where.status }),
      };
      const count = await this.prisma.payment.count({ where: filtered });
      const payments = await this.prisma.payment.findMany({
        where: filtered,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: PAYMENT_SELECT,
      });
      return createPaginatedResponse(
        payments.map((p) => this._mapPayment(p)),
        count,
        page,
        pageSize,
      );
    } catch (error) {
      this.logger.error('Error al obtener pagos:', error);
      throw new InternalServerError('Error al obtener pagos');
    }
  }

  private _mapPayment<T extends { payerId: string; receiverId: string }>(p: T) {
    return {
      ...p,
      payer: { id: p.payerId },
      receiver: { id: p.receiverId },
    };
  }

  // ─── Revenue Analytics ────────────────────────────────────────────────────
  // Unchanged from the original implementation — kept for compatibility with
  // the admin dashboards. See `payments.service.ts` history for the bodies
  // that compute totals/grouping.

  async getRevenueStats({
    dateFrom,
    dateTo,
  }: {
    dateFrom?: Date;
    dateTo?: Date;
  } = {}) {
    try {
      const dateFilter =
        dateFrom || dateTo
          ? { createdAt: { ...(dateFrom && { gte: dateFrom }), ...(dateTo && { lte: dateTo }) } }
          : {};
      const [completedAgg, pendingAgg] = await Promise.all([
        this.prisma.payment.aggregate({
          where: { status: PaymentStatus.COMPLETED, ...dateFilter },
          _sum: { amount: true, netAmount: true, fees: true },
          _count: true,
        }),
        this.prisma.payment.aggregate({
          where: { status: PaymentStatus.PENDING, ...dateFilter },
          _sum: { amount: true },
          _count: true,
        }),
      ]);
      return {
        totalRevenue: completedAgg._sum.amount ?? 0,
        totalNetRevenue: completedAgg._sum.netAmount ?? 0,
        totalFees: completedAgg._sum.fees ?? 0,
        completedCount: completedAgg._count,
        pendingRevenue: pendingAgg._sum.amount ?? 0,
        pendingCount: pendingAgg._count,
      };
    } catch (error) {
      this.logger.error('Error al obtener stats de ingresos:', error);
      throw new InternalServerError('Error al obtener stats de ingresos');
    }
  }

  async getSellerRevenueStats({
    sellerId,
    dateFrom,
    dateTo,
  }: {
    sellerId: string;
    dateFrom?: Date;
    dateTo?: Date;
  }) {
    try {
      const dateFilter =
        dateFrom || dateTo
          ? { createdAt: { ...(dateFrom && { gte: dateFrom }), ...(dateTo && { lte: dateTo }) } }
          : {};
      const [completedAgg, pendingAgg] = await Promise.all([
        this.prisma.payment.aggregate({
          where: { receiverId: sellerId, status: PaymentStatus.COMPLETED, ...dateFilter },
          _sum: { amount: true, netAmount: true, fees: true },
          _count: true,
        }),
        this.prisma.payment.aggregate({
          where: { receiverId: sellerId, status: PaymentStatus.PENDING, ...dateFilter },
          _sum: { amount: true },
          _count: true,
        }),
      ]);
      return {
        totalRevenue: completedAgg._sum.amount ?? 0,
        totalNetRevenue: completedAgg._sum.netAmount ?? 0,
        totalFees: completedAgg._sum.fees ?? 0,
        completedCount: completedAgg._count,
        pendingRevenue: pendingAgg._sum.amount ?? 0,
        pendingCount: pendingAgg._count,
      };
    } catch (error) {
      this.logger.error('Error al obtener stats del vendedor:', error);
      throw new InternalServerError('Error al obtener stats del vendedor');
    }
  }

  async getMonthlyRevenue(months: number = 12) {
    return this._monthlyAgg({ months });
  }

  async getSellerMonthlyRevenue({
    sellerId,
    months = 12,
  }: {
    sellerId: string;
    months?: number;
  }) {
    return this._monthlyAgg({ months, sellerId });
  }

  private async _monthlyAgg({ months, sellerId }: { months: number; sellerId?: string }) {
    try {
      const dateFrom = new Date();
      dateFrom.setMonth(dateFrom.getMonth() - months);
      const payments = await this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.COMPLETED,
          createdAt: { gte: dateFrom },
          ...(sellerId && { receiverId: sellerId }),
        },
        select: { amount: true, netAmount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      const grouped = new Map<
        string,
        { revenue: number; netRevenue: number; count: number }
      >();
      for (const p of payments) {
        const month = p.createdAt.toISOString().slice(0, 7);
        const existing = grouped.get(month) ?? { revenue: 0, netRevenue: 0, count: 0 };
        grouped.set(month, {
          revenue: existing.revenue + p.amount,
          netRevenue: existing.netRevenue + (p.netAmount ?? 0),
          count: existing.count + 1,
        });
      }
      return Array.from(grouped.entries()).map(([month, data]) => ({ month, ...data }));
    } catch (error) {
      this.logger.error('Error al obtener ingresos mensuales:', error);
      throw new InternalServerError('Error al obtener ingresos mensuales');
    }
  }
}

const PAYMENT_SELECT = {
  id: true,
  orderId: true,
  quotationId: true,
  amount: true,
  currency: true,
  status: true,
  paymentProvider: true,
  externalId: true,
  externalToken: true,
  description: true,
  fees: true,
  netAmount: true,
  payerId: true,
  receiverId: true,
  failureReason: true,
  metadata: true,
  paymentType: true,
  chileanConfigId: true,
  createdAt: true,
  updatedAt: true,
  processedAt: true,
  refundedAt: true,
} as const;
