import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  OrderStatus as PrismaOrderStatus,
  PaymentStatus as PrismaPaymentStatus,
  PaymentType as PrismaPaymentType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ServicesClient, UsersClient } from '../common/clients/index.js';
import { assertAdminCan } from '../common/admin-access.js';
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
  PaymentStatus,
  PaymentType,
} from '../graphql/enums/index.js';
import { OrdersService } from '../orders/orders.service.js';
import { MercadoPagoAdapter, ProviderRegistry } from './providers/index.js';
import type { ConfirmPaymentResult } from './providers/index.js';
import { SettlementService } from './settlement.service.js';
import { CommissionService } from './commission.service.js';
import { PaymentSecrets } from './payment-secrets.js';
import { recordPaymentOutcome } from './payments.metrics.js';
import { MercadoPagoConnectService } from './mercadopago/mercadopago-connect.service.js';
import { verifyMercadoPagoSignature } from './mercadopago/mercadopago-signature.js';
import { paymentIdFromReference } from './providers/mercadopago.adapter.js';

// Kept as a re-export for the processor and module that import it from here.
export { PAYMENT_QUEUE } from './payment-queue.js';

/** A payment in one of these states is never committed or changed by a provider again. */
const FINAL_PAYMENT_STATUSES: PrismaPaymentStatus[] = [
  PrismaPaymentStatus.COMPLETED,
  PrismaPaymentStatus.FAILED,
  PrismaPaymentStatus.CANCELLED,
  PrismaPaymentStatus.EXPIRED,
  PrismaPaymentStatus.REFUNDED,
  PrismaPaymentStatus.PARTIALLY_REFUNDED,
];

/**
 * Mercado Pago outcomes that do not end a checkout. On Checkout Pro a buyer
 * whose card is rejected can retry on the same page, so a FAILED payment may
 * still be approved by a later attempt. EXPIRED is our own timeout, not a
 * provider outcome, so a charge can still land on it as the window closes.
 * Webpay has neither: one form, one commit.
 */
const MERCADOPAGO_REOPENABLE: PrismaPaymentStatus[] = [
  PrismaPaymentStatus.FAILED,
  PrismaPaymentStatus.EXPIRED,
];

/** Whether the provider may no longer change a payment. */
function isSettled(
  status: PrismaPaymentStatus,
  provider: ChileanPaymentProvider,
): boolean {
  if (
    provider === ChileanPaymentProvider.MERCADOPAGO &&
    MERCADOPAGO_REOPENABLE.includes(status)
  ) {
    return false;
  }
  return FINAL_PAYMENT_STATUSES.includes(status);
}

/** A non-empty string (or a number) from an untyped payload, else undefined. */
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : undefined;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly providers: ProviderRegistry,
    private readonly users: UsersClient,
    private readonly config: ConfigService,
    private readonly settlement: SettlementService,
    private readonly services: ServicesClient,
    private readonly commission: CommissionService,
    private readonly mercadoPago: MercadoPagoAdapter,
    private readonly mercadoPagoConnect: MercadoPagoConnectService,
    private readonly secrets: PaymentSecrets,
  ) {}

  /** Providers buyers may pay with now (`PAYMENT_PROVIDERS`); Webpay waits as a future option. */
  enabledProviders(): ChileanPaymentProvider[] {
    const configured = this.config.get<string[]>(
      'payments.enabledProviders',
    ) ?? [ChileanPaymentProvider.MERCADOPAGO];
    const known = Object.values(ChileanPaymentProvider) as string[];
    return configured.filter((p) =>
      known.includes(p),
    ) as ChileanPaymentProvider[];
  }

  private _assertProviderEnabled(provider: ChileanPaymentProvider): void {
    const enabled = this.enabledProviders();
    if (!enabled.includes(provider)) {
      throw new BadRequestError(
        `${provider} no está habilitado. Paga con ${enabled.join(' o ') || 'otro medio'}.`,
      );
    }
  }

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
      if (!config)
        throw new NotFoundError('Configuración de pago no encontrada');
      return config;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al obtener la configuración de pago:', error);
      throw new InternalServerError(
        'Error al obtener la configuración de pago',
      );
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
            provider: input.provider,
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
          apiKey: this.secrets.seal(input.apiKey),
          secretKey: this.secrets.seal(input.secretKey),
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
    this._assertProviderEnabled(input.provider);

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
    if (order.status !== PrismaOrderStatus.PENDING_PAYMENT) {
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

    // 3. EKORU's commission for this seller (TRX-10), kept on the payment.
    const commission = await this.commission.quote({
      sellerId: order.sellerId,
      amount: order.total,
    });

    // 4. Persist a PENDING Payment row first so we have an id for the
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
        fees: commission.fee,
        netAmount: commission.net,
        feePercentage: commission.rate,
        updatedAt: new Date(),
      },
      select: PAYMENT_SELECT,
    });

    // 5. Hand off to the provider adapter.
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
        platformFee: commission.fee,
        config: this.secrets.credentials(config),
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

    // 6. Persist the provider's externalId/token.
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
   * Creates a platform Payment for a membership subscription — money flows to
   * EKORU, not to a seller. Same Webpay rail as `createPayment`, but:
   *   - the receiver is EKORU's own platform Seller (env EKORU_PLATFORM_SELLER_ID),
   *   - the amount/currency/term come from the users subgraph (server-side price),
   *   - paymentType is MEMBERSHIP with the plan in `metadata`, and there is no
   *     Order — activation happens on the return (see handleProviderReturn).
   */
  async createMembershipPayment({
    membershipId,
    payerId,
    returnUrl,
    provider = this.enabledProviders()[0] ?? ChileanPaymentProvider.MERCADOPAGO,
  }: {
    membershipId: number;
    payerId: string;
    returnUrl: string;
    provider?: ChileanPaymentProvider;
  }) {
    if (!payerId) {
      throw new BadRequestError('Debe iniciar sesión para suscribirse');
    }
    this._assertProviderEnabled(provider);

    const platformSellerId = this.config.get<string>('ekoruPlatformSellerId');
    if (!platformSellerId) {
      throw new InternalServerError('EKORU_PLATFORM_SELLER_ID no configurado');
    }

    // 1. Price the term server-side (never from the client).
    const charge = await this.users.getMembershipCharge(membershipId, payerId);

    // 2. Resolve EKORU's own config for the provider — the receiving account.
    const config = await this.prisma.chileanPaymentConfig.findFirst({
      where: { sellerId: platformSellerId, provider, isActive: true },
    });
    if (!config) {
      throw new BadRequestError(
        `EKORU no tiene ${provider} configurado para cobros de plataforma`,
      );
    }

    // 3. Persist a PROCESSING Payment (receiver = EKORU, type = MEMBERSHIP).
    const payment = await this.prisma.payment.create({
      data: {
        amount: charge.price,
        currency: charge.currency,
        paymentProvider: provider,
        description: `Suscripción EKORU (plan ${membershipId})`,
        payerId,
        receiverId: platformSellerId,
        paymentType: PaymentType.MEMBERSHIP,
        chileanConfigId: config.id,
        status: PaymentStatus.PROCESSING,
        metadata: { membershipId } as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
      select: PAYMENT_SELECT,
    });

    // 4. Hand off to the provider. No Order → pass 0 as the buyOrder seed.
    const adapter = this.providers.for(provider);
    let initiate: Awaited<ReturnType<typeof adapter.initiate>>;
    try {
      initiate = await adapter.initiate({
        paymentId: payment.id,
        orderId: 0,
        amount: charge.price,
        currency: charge.currency,
        description: 'EKORU suscripción',
        returnUrl,
        config: this.secrets.credentials(config),
      });
    } catch (err) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: err instanceof Error ? err.message : 'unknown',
        },
      });
      throw err;
    }

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
        amount: charge.price,
        status: PaymentStatus.PROCESSING,
        description: `Suscripción iniciada con ${provider}`,
      },
    });

    return {
      paymentId: String(updated.id),
      provider,
      status: updated.status,
      redirect: initiate.redirect,
      payment: this._mapPayment(updated),
    };
  }

  /**
   * Pays an accepted quotation (TRX-6). The amount, client, provider and state
   * come from ekoru-services (`finalPrice ?? estimatedPrice`), never from the
   * client; only the quotation's client may pay it, once. The money goes to
   * the provider's own payment config, like an order. On completion
   * SettlementService stamps the quotation paid in services.
   */
  async createQuotationPayment({
    quotationId,
    returnUrl,
    provider,
    payerId,
  }: {
    quotationId: number;
    returnUrl: string;
    provider: ChileanPaymentProvider;
    payerId?: string;
  }) {
    if (!payerId) {
      throw new BadRequestError('Debe iniciar sesión para pagar');
    }
    this._assertProviderEnabled(provider);
    const charge = await this.services.getQuotationCharge(quotationId);
    if (charge.clientId !== payerId) {
      throw new BadRequestError('Esta cotización no te pertenece');
    }
    if (charge.status !== 'ACCEPTED') {
      throw new BadRequestError(
        'Solo se paga una cotización aceptada (estado actual: ' +
          charge.status +
          ')',
      );
    }
    if (charge.paid) {
      throw new BadRequestError('Esta cotización ya está pagada');
    }
    if (charge.amount == null || charge.amount <= 0) {
      throw new BadRequestError('Esta cotización no tiene un monto por pagar');
    }

    const config = await this.prisma.chileanPaymentConfig.findFirst({
      where: { sellerId: charge.providerId, provider, isActive: true },
    });
    if (!config) {
      throw new BadRequestError(
        `El proveedor no tiene ${provider} configurado`,
      );
    }

    const commission = await this.commission.quote({
      sellerId: charge.providerId,
      amount: charge.amount,
    });
    const payment = await this.prisma.payment.create({
      data: {
        quotationId,
        amount: charge.amount,
        currency: charge.currency,
        paymentProvider: provider,
        description: `Cotización #${quotationId}`,
        payerId,
        receiverId: charge.providerId,
        paymentType: PaymentType.QUOTATION,
        chileanConfigId: config.id,
        status: PaymentStatus.PROCESSING,
        fees: commission.fee,
        netAmount: commission.net,
        feePercentage: commission.rate,
        updatedAt: new Date(),
      },
      select: PAYMENT_SELECT,
    });

    const adapter = this.providers.for(provider);
    let initiate: Awaited<ReturnType<typeof adapter.initiate>>;
    try {
      initiate = await adapter.initiate({
        paymentId: payment.id,
        // Seeds the provider's buy order; a quotation has no order.
        orderId: quotationId,
        amount: charge.amount,
        currency: charge.currency,
        description: `Cotización Ekoru #${quotationId}`,
        returnUrl,
        platformFee: commission.fee,
        config: this.secrets.credentials(config),
      });
    } catch (err) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.FAILED,
          failureReason: err instanceof Error ? err.message : 'unknown',
        },
      });
      throw err;
    }

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
        amount: charge.amount,
        status: PaymentStatus.PROCESSING,
        description: `Pago de cotización iniciado con ${provider}`,
      },
    });

    return {
      paymentId: String(updated.id),
      provider,
      status: updated.status,
      redirect: initiate.redirect,
      payment: this._mapPayment(updated),
    };
  }

  /**
   * Refunds a completed payment (TRX-2). Platform admins with PROCESS_REFUNDS
   * only; anyone could call it before. The refund is capped at what is left
   * to give back, and the provider is called for real in the queue
   * (SettlementService.executeRefund); nothing is marked refunded until the
   * provider says so.
   */
  async refundPayment({
    input,
    adminId,
  }: {
    input: RefundPaymentInput;
    adminId?: string;
  }) {
    await assertAdminCan(this.prisma, adminId, 'PROCESS_REFUNDS');
    return this.settlement.requestRefund({
      paymentId: input.paymentId,
      amount: input.amount,
      reason: input.reason,
      requestedBy: adminId,
    });
  }

  // ─── Provider return/webhook handlers (called by gateway) ─────────────────

  /**
   * Called by the gateway's `POST /payments/return/:provider` route after
   * the buyer is redirected back from the provider. The gateway has already
   * authenticated the request as coming from itself (internal secret).
   *
   * For Webpay this is the only commit signal (no webhook). Mercado Pago also
   * sends a webhook; either one settles the payment, whichever arrives first,
   * and both read the status back from Mercado Pago's API.
   */
  async handleProviderReturn({
    provider,
    rawPayload,
  }: {
    provider: ChileanPaymentProvider;
    rawPayload: Record<string, unknown>;
  }): Promise<{ paymentId: number; status: PaymentStatus }> {
    const payment = await this._findPaymentForReturn(provider, rawPayload);
    if (!payment) {
      throw new NotFoundError('No se encontró el pago para este retorno');
    }
    // A buyer reloading the return page sends it again. Transbank refuses a
    // second commit, which used to turn a COMPLETED payment into FAILED.
    if (isSettled(payment.status, provider)) {
      return {
        paymentId: payment.id,
        status: payment.status as unknown as PaymentStatus,
      };
    }

    const config = await this.prisma.chileanPaymentConfig.findUnique({
      where: { id: payment.chileanConfigId },
    });
    if (!config) throw new NotFoundError('Configuración no encontrada');

    const adapter = this.providers.for(provider);
    const result = await adapter.confirm({
      paymentId: payment.id,
      amount: payment.amount,
      externalId: payment.externalId!,
      externalToken: payment.externalToken,
      config: this.secrets.credentials(config),
      rawPayload,
    });

    // A buyer back from Mercado Pago without paying changes nothing: the
    // payment waits for the webhook or the expiry sweep. A failed or expired
    // one stays as it is unless the provider reports a real outcome.
    if (
      result.status === 'PROCESSING' &&
      payment.status !== PrismaPaymentStatus.PENDING &&
      payment.status !== PrismaPaymentStatus.PROCESSING
    ) {
      return {
        paymentId: payment.id,
        status: payment.status as unknown as PaymentStatus,
      };
    }

    const status = await this._settle(payment, result, provider);
    return { paymentId: payment.id, status };
  }

  /**
   * Records what the provider said and runs what follows: an order paid or
   * canceled, a quotation stamped paid, a membership activated.
   */
  private async _settle(
    payment: {
      id: number;
      orderId: number | null;
      paymentType: PrismaPaymentType;
      payerId: string;
      metadata: Prisma.JsonValue | null;
    },
    result: ConfirmPaymentResult,
    provider: ChileanPaymentProvider,
  ): Promise<PaymentStatus> {
    await this._applyTerminalStatus(
      payment.id,
      payment.orderId,
      result.status,
      result.raw,
      result.providerPaymentId,
      {
        // A rejected Mercado Pago attempt leaves the order open for a retry on
        // the same checkout; the expiry sweep closes it if none succeeds.
        keepOrderOpen:
          provider === ChileanPaymentProvider.MERCADOPAGO &&
          result.status === 'FAILED',
      },
    );

    // Platform (subscription) payments have no Order to mark paid — instead a
    // completed one activates the membership over in the users subgraph.
    const status = this._toPaymentStatus(result.status);
    if (
      payment.paymentType === PrismaPaymentType.MEMBERSHIP &&
      status === PaymentStatus.COMPLETED
    ) {
      await this._activateMembership(payment);
    }
    return status;
  }

  /**
   * Tells the users subgraph to create the subscription for a completed
   * membership Payment. Best-effort: a failure here is logged (and recoverable
   * from the Payment + its metadata) rather than un-doing a real charge.
   */
  private async _activateMembership(payment: {
    id: number;
    payerId: string;
    metadata: Prisma.JsonValue | null;
  }): Promise<void> {
    const meta = (payment.metadata ?? {}) as { membershipId?: number };
    if (!meta.membershipId) {
      this.logger.error(
        `Membership payment ${payment.id} completed without membershipId in metadata — cannot activate`,
      );
      return;
    }
    try {
      await this.users.activateMembership({
        sellerId: payment.payerId,
        membershipId: meta.membershipId,
        paymentId: payment.id,
      });
    } catch (err) {
      this.logger.error(
        `Subscription activation failed for payment ${payment.id}`,
        err,
      );
    }
  }

  /**
   * Called by the gateway's `POST /payments/webhook/:provider` route.
   *
   * **This layer owns signature verification.** The gateway cannot do it: the
   * HMAC key is the seller's `secretKey`, and which seller a webhook belongs to
   * is only known after the payment lookup below. The gateway's handler only
   * rejects obviously unsigned requests and forwards the raw bytes.
   *
   * Previously each layer's comments claimed the other one verified, and
   * `KhipuAdapter.verifySignature` — correct code — had no callers at all, so
   * any request with a non-empty signature header was accepted as genuine.
   */
  async handleProviderWebhook({
    provider,
    eventType,
    rawPayload,
    rawBody,
    signature,
    requestId,
    query,
  }: {
    provider: ChileanPaymentProvider;
    eventType: string;
    rawPayload: Record<string, unknown>;
    /** Exact bytes the provider signed. The HMAC is over these, not over a re-serialization of `rawPayload`. */
    rawBody?: string;
    signature?: string;
    /** Mercado Pago: the `x-request-id` header, part of what it signs. */
    requestId?: string;
    /** Mercado Pago: the notification URL's query (`data.id`, `type`, our `ekoru_payment` hint). */
    query?: Record<string, unknown>;
  }): Promise<{ paymentId?: number; status?: PaymentStatus }> {
    if (provider === ChileanPaymentProvider.MERCADOPAGO) {
      return this._handleMercadoPagoWebhook({
        eventType,
        rawPayload,
        signature,
        requestId,
        query: query ?? {},
      });
    }

    const externalId = this._extractExternalId(provider, rawPayload);
    const payment = externalId
      ? await this.prisma.payment.findFirst({
          where: { externalId, paymentProvider: provider },
          select: {
            id: true,
            orderId: true,
            status: true,
            order: { select: { sellerId: true } },
          },
        })
      : null;

    const verified = await this._verifyWebhookSignature({
      provider,
      sellerId: payment?.order?.sellerId,
      rawBody,
      signature,
    });

    // Record the attempt either way — an unverified webhook is exactly the
    // thing you want a trail of — but never let it change payment state.
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

    if (!verified) {
      this.logger.warn(
        `Rejected ${provider} webhook for externalId ${externalId ?? 'unknown'}: signature not verified`,
      );
      throw new BadRequestError('Webhook signature verification failed');
    }

    const adapter = this.providers.for(provider);
    const result = await adapter.handleWebhook(rawPayload);

    if (
      payment &&
      result.status !== 'PROCESSING' &&
      !FINAL_PAYMENT_STATUSES.includes(payment.status)
    ) {
      await this._applyTerminalStatus(
        payment.id,
        payment.orderId,
        result.status,
        result.raw,
      );
      return {
        paymentId: payment.id,
        status: this._toPaymentStatus(result.status),
      };
    }
    return { paymentId: payment?.id };
  }

  /**
   * A Mercado Pago webhook (TRX-16). It only names a resource, so:
   *   1. the `x-signature` must verify with EKORU's application secret, or
   *      nothing happens (the attempt is still recorded);
   *   2. the store's token is found from our `ekoru_payment` hint, or from
   *      the account id Mercado Pago sends (`user_id`);
   *   3. the payment is read back from Mercado Pago, and its reference must
   *      be ours, before the status is applied.
   * A forged or replayed notification can at most make us re-read a payment.
   * `mp-connect` notifications tell us a store unlinked EKORU.
   */
  private async _handleMercadoPagoWebhook({
    eventType,
    rawPayload,
    signature,
    requestId,
    query,
  }: {
    eventType: string;
    rawPayload: Record<string, unknown>;
    signature?: string;
    requestId?: string;
    query: Record<string, unknown>;
  }): Promise<{ paymentId?: number; status?: PaymentStatus }> {
    const provider = ChileanPaymentProvider.MERCADOPAGO;
    const queryDataId = str(query['data.id']);
    const resourceId =
      queryDataId ?? str((rawPayload['data'] as { id?: unknown })?.id);
    const type = str(rawPayload['type']) ?? str(query['type']) ?? eventType;
    const hint = Number(str(query['ekoru_payment']));
    const accountId = str(rawPayload['user_id']);

    let payment = Number.isInteger(hint)
      ? await this.prisma.payment.findFirst({
          where: { id: hint, paymentProvider: provider },
          select: RETURN_SELECT,
        })
      : null;

    const webhook = await this.prisma.paymentWebhook.create({
      data: {
        paymentId: payment?.id,
        provider,
        eventType: type,
        externalId: resourceId ?? 'unknown',
        payload: rawPayload as Prisma.InputJsonValue,
        processed: false,
      },
      select: { id: true },
    });
    const done = (data: { paymentId?: number; processingError?: string }) =>
      this.prisma.paymentWebhook.update({
        where: { id: webhook.id },
        data: {
          ...data,
          processed: !data.processingError,
          processedAt: new Date(),
        },
      });

    const verified = verifyMercadoPagoSignature({
      signatureHeader: signature,
      requestId,
      // Mercado Pago signs the query's data.id; one that did not come there is left out.
      dataId: queryDataId,
      secret: this.config.get<string>('mercadoPago.webhookSecret'),
    });
    if (!verified) {
      this.logger.warn(
        `Rejected Mercado Pago webhook for ${resourceId ?? 'unknown'}: signature not verified`,
      );
      throw new BadRequestError('Webhook signature verification failed');
    }

    if (type === 'mp-connect') {
      if (accountId && str(rawPayload['action'])?.includes('deauthorized')) {
        await this.mercadoPagoConnect.deauthorize(accountId);
      }
      await done({});
      return {};
    }
    if (type !== 'payment' || !resourceId) {
      await done({});
      return {};
    }

    // The store's connection: the hinted payment's, else the account's.
    let config = payment
      ? await this.prisma.chileanPaymentConfig.findUnique({
          where: { id: payment.chileanConfigId },
        })
      : null;
    if (!config && accountId) {
      config = await this.prisma.chileanPaymentConfig.findFirst({
        where: { provider, merchantId: accountId },
        orderBy: { updatedAt: 'desc' },
      });
    }
    if (!config) {
      await done({
        processingError: 'No store connection for this notification',
      });
      return {};
    }

    if (!payment) {
      const id = await this.mercadoPago.identify({
        providerPaymentId: resourceId,
        config: this.secrets.credentials(config),
      });
      payment = id
        ? await this.prisma.payment.findFirst({
            where: {
              id,
              paymentProvider: provider,
              chileanConfigId: config.id,
            },
            select: RETURN_SELECT,
          })
        : null;
    }
    if (!payment) {
      await done({ processingError: 'Not an EKORU payment' });
      return {};
    }
    if (isSettled(payment.status, provider)) {
      // A paid charge can still change at Mercado Pago (TRX-22).
      if (
        payment.status === PrismaPaymentStatus.COMPLETED ||
        payment.status === PrismaPaymentStatus.PARTIALLY_REFUNDED
      ) {
        await this._followPaidCharge({
          paymentId: payment.id,
          providerPaymentId: resourceId,
          config,
        });
      }
      await done({ paymentId: payment.id });
      return { paymentId: payment.id };
    }

    const result = await this.mercadoPago.resolve({
      paymentId: payment.id,
      amount: payment.amount,
      externalId: payment.externalId ?? '',
      providerPaymentId: resourceId,
      config: this.secrets.credentials(config),
    });
    if (result.status === 'PROCESSING') {
      await done({ paymentId: payment.id });
      return { paymentId: payment.id };
    }
    const status = await this._settle(payment, result, provider);
    await done({ paymentId: payment.id });
    return { paymentId: payment.id, status };
  }

  /**
   * What happened to a paid Mercado Pago charge since (TRX-22): a refund the
   * store made from its own account is recorded like one made in the panel,
   * and a chargeback or an open claim is logged for support.
   */
  private async _followPaidCharge({
    paymentId,
    providerPaymentId,
    config,
  }: {
    paymentId: number;
    providerPaymentId: string;
    config: {
      environment: 'SANDBOX' | 'PRODUCTION';
      merchantId: string | null;
      apiKey: string | null;
      secretKey: string | null;
    };
  }): Promise<void> {
    const charge = await this.mercadoPago.inspect({
      providerPaymentId,
      config: this.secrets.credentials(config),
    });
    if (charge.paymentId !== paymentId) return;
    if (charge.status === 'charged_back' || charge.status === 'in_mediation') {
      await this.settlement.recordDispute({
        paymentId,
        kind: charge.status === 'charged_back' ? 'CHARGEBACK' : 'MEDIATION',
        raw: charge.raw,
      });
    }
    if (charge.refunded > 0) {
      await this.settlement.recordExternalRefund({
        paymentId,
        refundedTotal: charge.refunded,
        raw: charge.raw,
      });
    }
  }

  /**
   * Job, before the expiry sweep: asks Mercado Pago about payments still
   * waiting past the window (the buyer never came back and the webhook never
   * arrived), so a paid one is settled instead of expired.
   */
  async reconcileStale(windowMinutes: number): Promise<number> {
    const before = new Date(Date.now() - windowMinutes * 60_000);
    const stale = await this.prisma.payment.findMany({
      where: {
        paymentProvider: ChileanPaymentProvider.MERCADOPAGO,
        createdAt: { lt: before },
        OR: [
          {
            status: {
              in: [PrismaPaymentStatus.PENDING, PrismaPaymentStatus.PROCESSING],
            },
          },
          // A rejected attempt may have been followed by an approved one whose
          // webhook was lost: ask once more as the window closes, not forever.
          {
            status: PrismaPaymentStatus.FAILED,
            createdAt: { gt: new Date(before.getTime() - 30 * 60_000) },
          },
        ],
      },
      select: { ...RETURN_SELECT, chileanPaymentConfig: true },
      take: 100,
    });
    let settled = 0;
    for (const payment of stale) {
      try {
        const result = await this.mercadoPago.lookup({
          paymentId: payment.id,
          amount: payment.amount,
          externalId: payment.externalId ?? '',
          config: this.secrets.credentials(payment.chileanPaymentConfig),
        });
        if (result.status === 'PROCESSING') continue;
        await this._settle(payment, result, ChileanPaymentProvider.MERCADOPAGO);
        settled++;
      } catch (error) {
        this.logger.warn(
          `Could not reconcile Mercado Pago payment ${payment.id}: ${String(error)}`,
        );
      }
    }
    if (settled)
      this.logger.log(`Reconciled ${settled} Mercado Pago payment(s)`);
    return settled;
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /**
   * Decides whether an inbound webhook really came from the provider.
   *
   * Fails closed: anything missing — the raw body, the header, the payment, the
   * seller's config, the secret — is a rejection, never a pass. A webhook we
   * cannot attribute to a payment is one we cannot verify, and an unverifiable
   * webhook must not be allowed to move money.
   */
  private async _verifyWebhookSignature({
    provider,
    sellerId,
    rawBody,
    signature,
  }: {
    provider: ChileanPaymentProvider;
    sellerId?: string;
    rawBody?: string;
    signature?: string;
  }): Promise<boolean> {
    // Webpay has no async webhook at all — the buyer's return POST is the
    // signal, and that path goes through `handleProviderReturn`, which commits
    // against Transbank directly. Nothing to verify here.
    if (provider === ChileanPaymentProvider.WEBPAY) return true;

    // Mercado Pago signs with EKORU's application secret, not a seller's, and
    // is verified in _handleMercadoPagoWebhook; it never reaches this path.
    if (provider === ChileanPaymentProvider.MERCADOPAGO) return false;

    if (!rawBody || !signature || !sellerId) return false;

    const config = await this.prisma.chileanPaymentConfig.findUnique({
      where: { sellerId_provider: { sellerId, provider } },
      select: { secretKey: true, isActive: true },
    });
    if (!config?.isActive || !config.secretKey) return false;

    const adapter = this.providers.for(provider);
    if (typeof adapter.verifySignature !== 'function') return false;

    const secret = this.secrets.open(config.secretKey);
    if (!secret) return false;
    return adapter.verifySignature(rawBody, signature, secret);
  }

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
    /** Mercado Pago's payment id, known once paid: refunds key on it. */
    providerPaymentId?: string,
    { keepOrderOpen = false }: { keepOrderOpen?: boolean } = {},
  ) {
    const status = this._toPaymentStatus(rawStatus);
    const isTerminal = status !== PaymentStatus.PROCESSING;
    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      select: { paymentProvider: true, paymentType: true },
      data: {
        status,
        ...(providerPaymentId ? { externalToken: providerPaymentId } : {}),
        processedAt:
          status === PaymentStatus.COMPLETED ? new Date() : undefined,
        failureReason:
          status === PaymentStatus.FAILED || status === PaymentStatus.CANCELLED
            ? typeof raw['error'] === 'string'
              ? raw['error']
              : null
            : undefined,
        updatedAt: new Date(),
      },
    });
    if (isTerminal) {
      recordPaymentOutcome({
        provider: String(updated?.paymentProvider ?? 'UNKNOWN'),
        type: String(updated?.paymentType ?? 'UNKNOWN'),
        status,
      });
    }
    await this.prisma.paymentTransaction.create({
      data: {
        paymentId,
        action: 'STATUS',
        status,
        description: `Provider reported ${rawStatus}`,
        metadata: raw as Prisma.InputJsonValue,
      },
    });
    if (status === PaymentStatus.COMPLETED) {
      // Order paid + stock, quotation stamped paid, duplicates refunded.
      await this.settlement.onCompleted(paymentId);
    } else if (
      orderId &&
      isTerminal &&
      !keepOrderOpen &&
      (status === PaymentStatus.FAILED ||
        status === PaymentStatus.CANCELLED ||
        status === PaymentStatus.EXPIRED)
    ) {
      await this.orders.markCanceled(orderId);
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
   * Locates the canonical Payment row for a provider return.
   *
   * Webpay's normal return carries only `token_ws` (no buy order), which we
   * stored as `externalToken`, so we look up by token there. Its abort/timeout
   * returns instead carry `TBK_ORDEN_COMPRA` (our `externalId`) with no usable
   * token. Mercado Pago's return carries our `external_reference`
   * (`ekoru-pay-<id>`) and the `preference_id` we stored as `externalId`.
   * The adapter then checks the payment it names really carries that
   * reference, so a tampered query cannot settle someone else's payment.
   *
   * Looking up by token first also avoids a `findFirst({ externalId: undefined })`
   * that would otherwise silently match the first Webpay row in the table.
   */
  private async _findPaymentForReturn(
    provider: ChileanPaymentProvider,
    payload: Record<string, unknown>,
  ) {
    const select = RETURN_SELECT;

    if (provider === ChileanPaymentProvider.WEBPAY) {
      const tokenWs = payload['token_ws'] as string | undefined;
      if (tokenWs) {
        const byToken = await this.prisma.payment.findFirst({
          where: { externalToken: tokenWs, paymentProvider: provider },
          select,
        });
        if (byToken) return byToken;
      }
    }

    if (provider === ChileanPaymentProvider.MERCADOPAGO) {
      const id = paymentIdFromReference(payload['external_reference']);
      if (id) {
        const byReference = await this.prisma.payment.findFirst({
          where: { id, paymentProvider: provider },
          select,
        });
        if (byReference) return byReference;
      }
    }

    const externalId = this._extractExternalId(provider, payload);
    if (!externalId) return null;
    return this.prisma.payment.findFirst({
      where: { externalId, paymentProvider: provider },
      select,
    });
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
        // The preference id is what createPayment stored as externalId.
        return str(payload['preference_id']);
    }
  }

  /** Any filter, for the admin payments list (TRX-11). Callers check access. */
  async listPayments({
    where,
    page,
    pageSize,
  }: {
    where: Prisma.PaymentWhereInput;
    page: number;
    pageSize: number;
  }) {
    const { skip, take } = calculatePrismaParams(page, pageSize);
    const [count, payments] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: PAYMENT_SELECT,
      }),
    ]);
    return createPaginatedResponse(
      payments.map((p) => this._mapPayment(p)),
      count,
      page,
      pageSize,
    );
  }

  /** A payment's refunds, newest first (admin payment detail). */
  listRefunds(paymentId: number) {
    return this.prisma.paymentRefund.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        paymentId: true,
        amount: true,
        reason: true,
        status: true,
        createdAt: true,
      },
    });
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
          ? {
              createdAt: {
                ...(dateFrom && { gte: dateFrom }),
                ...(dateTo && { lte: dateTo }),
              },
            }
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
          ? {
              createdAt: {
                ...(dateFrom && { gte: dateFrom }),
                ...(dateTo && { lte: dateTo }),
              },
            }
          : {};
      const [completedAgg, pendingAgg] = await Promise.all([
        this.prisma.payment.aggregate({
          where: {
            receiverId: sellerId,
            status: PaymentStatus.COMPLETED,
            ...dateFilter,
          },
          _sum: { amount: true, netAmount: true, fees: true },
          _count: true,
        }),
        this.prisma.payment.aggregate({
          where: {
            receiverId: sellerId,
            status: PaymentStatus.PENDING,
            ...dateFilter,
          },
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

  private async _monthlyAgg({
    months,
    sellerId,
  }: {
    months: number;
    sellerId?: string;
  }) {
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
        const existing = grouped.get(month) ?? {
          revenue: 0,
          netRevenue: 0,
          count: 0,
        };
        grouped.set(month, {
          revenue: existing.revenue + p.amount,
          netRevenue: existing.netRevenue + (p.netAmount ?? 0),
          count: existing.count + 1,
        });
      }
      return Array.from(grouped.entries()).map(([month, data]) => ({
        month,
        ...data,
      }));
    } catch (error) {
      this.logger.error('Error al obtener ingresos mensuales:', error);
      throw new InternalServerError('Error al obtener ingresos mensuales');
    }
  }
}

/** The Payment columns a return, a webhook or the reconcile job needs. */
const RETURN_SELECT = {
  id: true,
  amount: true,
  externalId: true,
  externalToken: true,
  chileanConfigId: true,
  orderId: true,
  // Needed to activate a subscription on a completed MEMBERSHIP payment.
  paymentType: true,
  status: true,
  payerId: true,
  metadata: true,
} as const;

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
  feePercentage: true,
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
