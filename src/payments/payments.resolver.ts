import { Resolver, Query, Mutation, Args, Int, ID, Context } from '@nestjs/graphql';
import { PaymentsService } from './payments.service.js';
import {
  Payment,
  PaymentRefund,
  ChileanPaymentConfig,
  PaymentConnection,
} from './entities/index.js';
import {
  CreatePaymentInput,
  CreatePaymentConfigInput,
  RefundPaymentInput,
} from './dto/index.js';
import { PaymentStatus } from '../graphql/enums/index.js';
import { CurrentSeller } from '../common/decorators/index.js';

@Resolver(() => Payment)
export class PaymentsResolver {
  constructor(private readonly paymentsService: PaymentsService) {}

  // ─── Payment Config Queries ────────────────────────────────────────────────

  @Query(() => ChileanPaymentConfig, {
    name: 'getPaymentConfig',
    nullable: true,
  })
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

  @Query(() => PaymentConnection, { name: 'getPaymentsByPayer' })
  async getPaymentsByPayer(
    @Args('payerId', { type: () => ID }) payerId: string,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('status', { type: () => PaymentStatus, nullable: true })
    status?: PaymentStatus,
  ) {
    return this.paymentsService.getPaymentsByPayer(
      payerId,
      page,
      pageSize,
      status,
    );
  }

  @Query(() => PaymentConnection, { name: 'getPaymentsByReceiver' })
  async getPaymentsByReceiver(
    @Args('receiverId', { type: () => ID }) receiverId: string,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('status', { type: () => PaymentStatus, nullable: true })
    status?: PaymentStatus,
  ) {
    return this.paymentsService.getPaymentsByReceiver(
      receiverId,
      page,
      pageSize,
      status,
    );
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  @Mutation(() => ChileanPaymentConfig)
  async createPaymentConfig(
    @Args('input') input: CreatePaymentConfigInput,
    @CurrentSeller() sellerId: string,
  ) {
    // Ensure the config belongs to the authenticated seller
    return this.paymentsService.createPaymentConfig({
      ...input,
      sellerId,
    });
  }

  @Mutation(() => Payment)
  async createPayment(@Args('input') input: CreatePaymentInput) {
    return this.paymentsService.createPayment(input);
  }

  @Mutation(() => PaymentRefund)
  async refundPayment(@Args('input') input: RefundPaymentInput) {
    return this.paymentsService.refundPayment(input);
  }
}
