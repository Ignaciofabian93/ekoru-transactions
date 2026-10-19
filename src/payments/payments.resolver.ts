import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  Context,
  Directive,
} from '@nestjs/graphql';
import { PaymentsService } from './payments.service.js';
import {
  Payment,
  PaymentRefund,
  ChileanPaymentConfig,
  PaymentConnection,
  RevenueStats,
  MonthlyRevenue,
  CreatePaymentResult,
  ProviderReturnResult,
} from './entities/index.js';
import {
  CreatePaymentInput,
  CreatePaymentConfigInput,
  RefundPaymentInput,
} from './dto/index.js';
import {
  ChileanPaymentProvider,
  PaymentStatus,
} from '../graphql/enums/index.js';
import { CurrentAdmin, CurrentSeller } from '../common/decorators/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertAdminCan,
  assertPartyOrAdmin,
  sellerScope,
} from '../common/admin-access.js';
import { GraphQLJSON } from '../graphql/scalars/index.js';
import { UnauthorizedError } from '../common/exceptions/index.js';

/** Revenue figures are the dashboard's (VIEW_ANALYTICS) and finance's. */
const REVENUE_PERMISSIONS = ['VIEW_ANALYTICS', 'VIEW_TRANSACTIONS'] as const;

@Resolver(() => Payment)
export class PaymentsResolver {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Payment Config Queries ────────────────────────────────────────────────

  @Query(() => ChileanPaymentConfig, {
    name: 'getPaymentConfig',
    nullable: true,
  })
  async getPaymentConfig(
    @Args('id', { type: () => ID }) id: string,
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const config = await this.paymentsService.getPaymentConfig(
      parseInt(id, 10),
    );
    await assertPartyOrAdmin(this.prisma, {
      sellerId,
      adminId,
      parties: [config.sellerId],
      permission: 'MANAGE_SETTINGS',
    });
    return config;
  }

  /** A seller's own payment configs; a platform admin names the seller. */
  @Query(() => [ChileanPaymentConfig], { name: 'getPaymentConfigsBySeller' })
  async getPaymentConfigsBySeller(
    @Args('sellerId', { type: () => ID, nullable: true }) requested?: string,
    @CurrentSeller() sessionSellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const sellerId = await sellerScope(this.prisma, {
      sellerId: sessionSellerId,
      adminId,
      requested,
      permission: 'MANAGE_SETTINGS',
    });
    return this.paymentsService.getPaymentConfigsBySeller(sellerId);
  }

  // ─── Payment Queries ───────────────────────────────────────────────────────

  /** The payer or the receiver, or a platform admin who reads payments. */
  @Query(() => Payment, { name: 'getPayment', nullable: true })
  async getPayment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    return this.readPayment({ id, sellerId, adminId });
  }

  /**
   * Polled by the web app's confirmation screen. Aliased as `payment` so
   * the GraphQL contract reads naturally (`payment(id: ID!) { status }`).
   */
  @Query(() => Payment, { name: 'payment', nullable: true })
  async payment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    return this.readPayment({ id, sellerId, adminId });
  }

  /** Payments a seller made; a platform admin names the payer. */
  @Query(() => PaymentConnection, { name: 'getPaymentsByPayer' })
  async getPaymentsByPayer(
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('payerId', { type: () => ID, nullable: true }) requested?: string,
    @Args('status', { type: () => PaymentStatus, nullable: true })
    status?: PaymentStatus,
    @CurrentSeller() sessionSellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const payerId = await sellerScope(this.prisma, {
      sellerId: sessionSellerId,
      adminId,
      requested,
      permission: 'VIEW_TRANSACTIONS',
    });
    return this.paymentsService.getPaymentsByPayer({
      payerId,
      page,
      pageSize,
      status,
    });
  }

  /** Payments a seller received; a platform admin names the receiver. */
  @Query(() => PaymentConnection, { name: 'getPaymentsByReceiver' })
  async getPaymentsByReceiver(
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('receiverId', { type: () => ID, nullable: true }) requested?: string,
    @Args('status', { type: () => PaymentStatus, nullable: true })
    status?: PaymentStatus,
    @CurrentSeller() sessionSellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const receiverId = await sellerScope(this.prisma, {
      sellerId: sessionSellerId,
      adminId,
      requested,
      permission: 'VIEW_TRANSACTIONS',
    });
    return this.paymentsService.getPaymentsByReceiver({
      receiverId,
      page,
      pageSize,
      status,
    });
  }

  // ─── Revenue Analytics ─────────────────────────────────────────────────────

  /** Platform-wide revenue: platform admins with VIEW_ANALYTICS or VIEW_TRANSACTIONS. */
  @Query(() => RevenueStats, { name: 'getRevenueStats' })
  async getRevenueStats(
    @Args('dateFrom', { type: () => Date, nullable: true }) dateFrom?: Date,
    @Args('dateTo', { type: () => Date, nullable: true }) dateTo?: Date,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, REVENUE_PERMISSIONS);
    return this.paymentsService.getRevenueStats({ dateFrom, dateTo });
  }

  /** A seller's own revenue; a platform admin names the seller. */
  @Query(() => RevenueStats, { name: 'getSellerRevenueStats' })
  async getSellerRevenueStats(
    @Args('sellerId', { type: () => ID, nullable: true }) requested?: string,
    @Args('dateFrom', { type: () => Date, nullable: true }) dateFrom?: Date,
    @Args('dateTo', { type: () => Date, nullable: true }) dateTo?: Date,
    @CurrentSeller() sessionSellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const sellerId = await sellerScope(this.prisma, {
      sellerId: sessionSellerId,
      adminId,
      requested,
      permission: REVENUE_PERMISSIONS,
    });
    return this.paymentsService.getSellerRevenueStats({
      sellerId,
      dateFrom,
      dateTo,
    });
  }

  @Query(() => [MonthlyRevenue], { name: 'getMonthlyRevenue' })
  async getMonthlyRevenue(
    @Args('months', { type: () => Int, defaultValue: 12 }) months: number,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, REVENUE_PERMISSIONS);
    return this.paymentsService.getMonthlyRevenue(months);
  }

  @Query(() => [MonthlyRevenue], { name: 'getSellerMonthlyRevenue' })
  async getSellerMonthlyRevenue(
    @Args('months', { type: () => Int, defaultValue: 12 }) months: number,
    @Args('sellerId', { type: () => ID, nullable: true }) requested?: string,
    @CurrentSeller() sessionSellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const sellerId = await sellerScope(this.prisma, {
      sellerId: sessionSellerId,
      adminId,
      requested,
      permission: REVENUE_PERMISSIONS,
    });
    return this.paymentsService.getSellerMonthlyRevenue({ sellerId, months });
  }

  /** The providers buyers can pay with now; clients offer only these. */
  @Query(() => [ChileanPaymentProvider], { name: 'enabledPaymentProviders' })
  enabledPaymentProviders() {
    return this.paymentsService.enabledProviders();
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  @Mutation(() => ChileanPaymentConfig)
  async createPaymentConfig(
    @Args('input') input: CreatePaymentConfigInput,
    @CurrentSeller() sellerId: string,
  ) {
    return this.paymentsService.createPaymentConfig({ ...input, sellerId });
  }

  /**
   * Creates a Payment for an existing PENDING_PAYMENT order and returns the
   * redirect the frontend should send the buyer through. The `payerId` is
   * resolved from the JWT — never from input.
   */
  @Mutation(() => CreatePaymentResult)
  async createPayment(
    @Args('input') input: CreatePaymentInput,
    @CurrentSeller() payerId: string,
  ) {
    return this.paymentsService.createPayment({ input, payerId });
  }

  /**
   * Starts a subscription payment to EKORU's own account. The plan price + term
   * are resolved server-side (users subgraph); on success the users subgraph
   * activates the membership. Returns the same redirect shape as createPayment.
   */
  @Mutation(() => CreatePaymentResult, { name: 'createMembershipPayment' })
  async createMembershipPayment(
    @Args('membershipId', { type: () => Int }) membershipId: number,
    @Args('returnUrl', { type: () => String }) returnUrl: string,
    @CurrentSeller() payerId: string,
    // Omitted: the first enabled provider (PAYMENT_PROVIDERS), Mercado Pago today.
    @Args('provider', { type: () => ChileanPaymentProvider, nullable: true })
    provider?: ChileanPaymentProvider,
  ) {
    return this.paymentsService.createMembershipPayment({
      membershipId,
      payerId,
      returnUrl,
      provider: provider ?? undefined,
    });
  }

  /**
   * Pays an accepted quotation (TRX-6). The client is the session; the amount
   * comes from ekoru-services. Same redirect shape as createPayment.
   */
  @Mutation(() => CreatePaymentResult, { name: 'createQuotationPayment' })
  async createQuotationPayment(
    @Args('quotationId', { type: () => Int }) quotationId: number,
    @Args('returnUrl', { type: () => String }) returnUrl: string,
    @Args('provider', {
      type: () => ChileanPaymentProvider,
      defaultValue: ChileanPaymentProvider.MERCADOPAGO,
    })
    provider: ChileanPaymentProvider,
    @CurrentSeller() payerId?: string,
  ) {
    return this.paymentsService.createQuotationPayment({
      quotationId,
      returnUrl,
      provider,
      payerId,
    });
  }

  /** Platform admins with PROCESS_REFUNDS (TRX-2). Capped and real. */
  @Mutation(() => PaymentRefund)
  async refundPayment(
    @Args('input') input: RefundPaymentInput,
    @CurrentAdmin() adminId?: string,
  ) {
    return this.paymentsService.refundPayment({ input, adminId });
  }

  // ─── Internal mutations (gateway → transactions) ───────────────────────────
  // These are NOT meant for the public schema. The gateway exposes the public
  // REST endpoints (`/payments/return/:provider`, `/payments/webhook/:provider`)
  // and calls these mutations behind an INTERNAL_SERVICE_SECRET header. We
  // verify that header here before mutating any payment state.

  // Internal: hidden from the public supergraph (GW-2); sibling services call it on this subgraph directly.
  @Directive('@inaccessible')
  @Mutation(() => ProviderReturnResult, { name: 'processProviderReturn' })
  async processProviderReturn(
    @Args('provider', { type: () => ChileanPaymentProvider })
    provider: ChileanPaymentProvider,
    @Args('payload', { type: () => GraphQLJSON })
    payload: Record<string, unknown>,
    @Context() ctx: { internalSecret?: string },
  ): Promise<ProviderReturnResult> {
    this._assertInternal(ctx);
    const result = await this.paymentsService.handleProviderReturn({
      provider,
      rawPayload: payload,
    });
    // Hand the internal Payment id back to the gateway so its confirmation
    // redirect carries a real `paymentId` — the normal Webpay return payload
    // (only `token_ws`) doesn't let the gateway re-derive it.
    return { paymentId: String(result.paymentId), status: result.status };
  }

  // Internal: hidden from the public supergraph (GW-2); sibling services call it on this subgraph directly.
  @Directive('@inaccessible')
  @Mutation(() => PaymentStatus, { name: 'processProviderWebhook' })
  async processProviderWebhook(
    @Args('provider', { type: () => ChileanPaymentProvider })
    provider: ChileanPaymentProvider,
    @Args('eventType', { type: () => String }) eventType: string,
    @Args('payload', { type: () => GraphQLJSON })
    payload: Record<string, unknown>,
    @Context() ctx: { internalSecret?: string },
    // The exact bytes the provider signed, forwarded verbatim by the gateway.
    // The HMAC is over these — re-serializing `payload` would change key order
    // and whitespace and never match.
    @Args('rawBody', { type: () => String, nullable: true })
    rawBody?: string,
    @Args('signature', { type: () => String, nullable: true })
    signature?: string,
    // Mercado Pago signs `x-request-id` and the query's `data.id` (TRX-16).
    @Args('requestId', { type: () => String, nullable: true })
    requestId?: string,
    @Args('query', { type: () => GraphQLJSON, nullable: true })
    query?: Record<string, unknown>,
  ) {
    this._assertInternal(ctx);
    const result = await this.paymentsService.handleProviderWebhook({
      provider,
      eventType,
      rawPayload: payload,
      rawBody,
      signature,
      requestId: requestId ?? undefined,
      query: query ?? undefined,
    });
    return result.status ?? PaymentStatus.PROCESSING;
  }

  private async readPayment({
    id,
    sellerId,
    adminId,
  }: {
    id: string;
    sellerId?: string;
    adminId?: string;
  }) {
    const payment = await this.paymentsService.getPayment(parseInt(id, 10));
    await assertPartyOrAdmin(this.prisma, {
      sellerId,
      adminId,
      parties: [payment.payerId, payment.receiverId],
      permission: ['VIEW_TRANSACTIONS', 'PROCESS_REFUNDS', 'MANAGE_ORDERS'],
    });
    return payment;
  }

  /**
   * Verifies the internal shared secret, accepted **only** from the
   * `x-internal-secret` header set by a direct service-to-service caller (the
   * gateway's PaymentsService).
   *
   * There used to be an `internalSecret` GraphQL argument as a fallback "so
   * dev curls work the same way". That put the credential in the public
   * schema, and because the gateway attached the header to every federated
   * request, the check passed for anonymous callers — these mutations were
   * effectively public. Both halves are now closed.
   */
  private _assertInternal(ctx: { internalSecret?: string }) {
    const expected = process.env.INTERNAL_SERVICE_SECRET;
    if (!expected) {
      throw new Error('INTERNAL_SERVICE_SECRET no configurado en transactions');
    }
    if (!ctx.internalSecret || ctx.internalSecret !== expected) {
      throw new UnauthorizedError('Internal operation');
    }
  }
}
