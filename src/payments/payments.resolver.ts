import { Resolver, Query, Mutation, Args, Int, ID, Context } from '@nestjs/graphql';
import { PaymentsService } from './payments.service.js';
import {
  Payment,
  PaymentRefund,
  ChileanPaymentConfig,
  PaymentConnection,
  RevenueStats,
  MonthlyRevenue,
  CreatePaymentResult,
} from './entities/index.js';
import {
  CreatePaymentInput,
  CreatePaymentConfigInput,
  RefundPaymentInput,
} from './dto/index.js';
import { ChileanPaymentProvider, PaymentStatus } from '../graphql/enums/index.js';
import { CurrentSeller } from '../common/decorators/index.js';
import { GraphQLJSON } from '../graphql/scalars/index.js';

@Resolver(() => Payment)
export class PaymentsResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  // ─── Payment Config Queries ────────────────────────────────────────────────

  @Query(() => ChileanPaymentConfig, { name: 'getPaymentConfig', nullable: true })
  async getPaymentConfig(@Args('id', { type: () => ID }) id: string) {
    return this.paymentsService.getPaymentConfig(parseInt(id, 10));
  }

  @Query(() => [ChileanPaymentConfig], { name: 'getPaymentConfigsBySeller' })
  async getPaymentConfigsBySeller(
    @Args('sellerId', { type: () => ID }) sellerId: string,
  ) {
    return this.paymentsService.getPaymentConfigsBySeller(sellerId);
  }

  // ─── Payment Queries ───────────────────────────────────────────────────────

  @Query(() => Payment, { name: 'getPayment', nullable: true })
  async getPayment(@Args('id', { type: () => ID }) id: string) {
    return this.paymentsService.getPayment(parseInt(id, 10));
  }

  /**
   * Polled by the web app's confirmation screen. Aliased as `payment` so
   * the GraphQL contract reads naturally (`payment(id: ID!) { status }`).
   */
  @Query(() => Payment, { name: 'payment', nullable: true })
  async payment(@Args('id', { type: () => ID }) id: string) {
    return this.paymentsService.getPayment(parseInt(id, 10));
  }

  @Query(() => PaymentConnection, { name: 'getPaymentsByPayer' })
  async getPaymentsByPayer(
    @Args('payerId', { type: () => ID }) payerId: string,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('status', { type: () => PaymentStatus, nullable: true }) status?: PaymentStatus,
  ) {
    return this.paymentsService.getPaymentsByPayer({
      payerId,
      page,
      pageSize,
      status,
    });
  }

  @Query(() => PaymentConnection, { name: 'getPaymentsByReceiver' })
  async getPaymentsByReceiver(
    @Args('receiverId', { type: () => ID }) receiverId: string,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('status', { type: () => PaymentStatus, nullable: true }) status?: PaymentStatus,
  ) {
    return this.paymentsService.getPaymentsByReceiver({
      receiverId,
      page,
      pageSize,
      status,
    });
  }

  // ─── Revenue Analytics ─────────────────────────────────────────────────────

  @Query(() => RevenueStats, { name: 'getRevenueStats' })
  async getRevenueStats(
    @Args('dateFrom', { type: () => Date, nullable: true }) dateFrom?: Date,
    @Args('dateTo', { type: () => Date, nullable: true }) dateTo?: Date,
  ) {
    return this.paymentsService.getRevenueStats({ dateFrom, dateTo });
  }

  @Query(() => RevenueStats, { name: 'getSellerRevenueStats' })
  async getSellerRevenueStats(
    @Args('sellerId', { type: () => ID }) sellerId: string,
    @Args('dateFrom', { type: () => Date, nullable: true }) dateFrom?: Date,
    @Args('dateTo', { type: () => Date, nullable: true }) dateTo?: Date,
  ) {
    return this.paymentsService.getSellerRevenueStats({
      sellerId,
      dateFrom,
      dateTo,
    });
  }

  @Query(() => [MonthlyRevenue], { name: 'getMonthlyRevenue' })
  async getMonthlyRevenue(
    @Args('months', { type: () => Int, defaultValue: 12 }) months: number,
  ) {
    return this.paymentsService.getMonthlyRevenue(months);
  }

  @Query(() => [MonthlyRevenue], { name: 'getSellerMonthlyRevenue' })
  async getSellerMonthlyRevenue(
    @Args('sellerId', { type: () => ID }) sellerId: string,
    @Args('months', { type: () => Int, defaultValue: 12 }) months: number,
  ) {
    return this.paymentsService.getSellerMonthlyRevenue({ sellerId, months });
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

  @Mutation(() => PaymentRefund)
  async refundPayment(@Args('input') input: RefundPaymentInput) {
    return this.paymentsService.refundPayment(input);
  }

  // ─── Internal mutations (gateway → transactions) ───────────────────────────
  // These are NOT meant for the public schema. The gateway exposes the public
  // REST endpoints (`/payments/return/:provider`, `/payments/webhook/:provider`)
  // and calls these mutations behind an INTERNAL_SERVICE_SECRET header. We
  // verify that header here before mutating any payment state.

  @Mutation(() => PaymentStatus, { name: 'processProviderReturn' })
  async processProviderReturn(
    @Args('provider', { type: () => ChileanPaymentProvider }) provider: ChileanPaymentProvider,
    @Args('payload', { type: () => GraphQLJSON }) payload: Record<string, unknown>,
    @Args('internalSecret', { type: () => String }) internalSecret: string,
    @Context() ctx: { internalSecret?: string },
  ) {
    this._assertInternal({ arg: internalSecret, ctx });
    const result = await this.paymentsService.handleProviderReturn({
      provider,
      rawPayload: payload,
    });
    return result.status;
  }

  @Mutation(() => PaymentStatus, { name: 'processProviderWebhook' })
  async processProviderWebhook(
    @Args('provider', { type: () => ChileanPaymentProvider }) provider: ChileanPaymentProvider,
    @Args('eventType', { type: () => String }) eventType: string,
    @Args('payload', { type: () => GraphQLJSON }) payload: Record<string, unknown>,
    @Args('internalSecret', { type: () => String }) internalSecret: string,
    @Context() ctx: { internalSecret?: string },
  ) {
    this._assertInternal({ arg: internalSecret, ctx });
    const result = await this.paymentsService.handleProviderWebhook({
      provider,
      eventType,
      rawPayload: payload,
    });
    return result.status ?? PaymentStatus.PROCESSING;
  }

  /**
   * Verifies the internal shared secret. The gateway sets it on its own
   * federation request header (e.g. `x-internal-secret`). Until that header
   * propagates, fall back to verifying via the explicit `internalSecret`
   * argument so dev curls work the same way.
   */
  private _assertInternal({
    arg,
    ctx,
  }: {
    arg: string;
    ctx: { internalSecret?: string };
  }) {
    const expected = process.env.INTERNAL_SERVICE_SECRET;
    if (!expected) {
      throw new Error('INTERNAL_SERVICE_SECRET no configurado en transactions');
    }
    const supplied = ctx.internalSecret ?? arg;
    if (supplied !== expected) {
      throw new Error('Unauthorized');
    }
  }
}
