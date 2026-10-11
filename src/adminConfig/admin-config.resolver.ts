import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { AdminConfigService } from './admin-config.service.js';
import { TransactionFee } from '../transactions/entities/index.js';
import { ShippingStatus } from '../orders/entities/shipping-status.entity.js';
import { ChileanPaymentConfig } from '../payments/entities/payment-config.entity.js';
import { TransactionsBulkUpsertResult } from '../common/bulk/index.js';
import { ChileanPaymentConfigConnectionEntity } from './entities/index.js';
import {
  TransactionFeeUpsertRowInput,
  ShippingStatusUpsertRowInput,
  ChileanPaymentConfigListArgs,
  ChileanPaymentConfigUpsertRowInput,
} from './dto/index.js';
import { CurrentAdmin } from '../common/decorators/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertAdminCan } from '../common/admin-access.js';

/**
 * Platform-admin CRUD for the transactions subgraph config tables (SEC-8,
 * TRX-8). Fees and payment configs are MANAGE_SETTINGS, shipping statuses
 * MANAGE_ORDERS, the permissions of their panel screens. The reads used to
 * answer anyone, signed out included.
 */
@Resolver()
export class AdminConfigResolver {
  constructor(
    private readonly adminConfigService: AdminConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Transaction fees ───────────────────────────────────────────────────────

  @Query(() => [TransactionFee], { name: 'adminTransactionFees' })
  async adminTransactionFees(@CurrentAdmin() adminId?: string) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_SETTINGS');
    return this.adminConfigService.getTransactionFees();
  }

  @Query(() => TransactionFee, {
    name: 'adminTransactionFee',
    nullable: true,
  })
  async adminTransactionFee(
    @Args('id', { type: () => ID }) id: string,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_SETTINGS');
    return this.adminConfigService.getTransactionFeeById(Number(id));
  }

  @Mutation(() => TransactionFee, {
    name: 'deleteTransactionFee',
    description: 'Delete a transaction fee. Admins only.',
  })
  deleteTransactionFee(
    @CurrentAdmin() adminId: string | undefined,
    @Args('id', { type: () => ID }) id: string,
  ) {
    return this.adminConfigService.deleteTransactionFee(adminId, Number(id));
  }

  @Mutation(() => TransactionsBulkUpsertResult, {
    description:
      'Bulk create/update transaction fees (rows with id update, without id create). Admins only.',
  })
  bulkUpsertTransactionFees(
    @CurrentAdmin() adminId: string | undefined,
    @Args('rows', { type: () => [TransactionFeeUpsertRowInput] })
    rows: TransactionFeeUpsertRowInput[],
  ) {
    return this.adminConfigService.bulkUpsertTransactionFees(adminId, rows);
  }

  // ─── Shipping statuses ──────────────────────────────────────────────────────

  @Query(() => [ShippingStatus], { name: 'adminShippingStatuses' })
  async adminShippingStatuses(@CurrentAdmin() adminId?: string) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_ORDERS');
    return this.adminConfigService.getShippingStatuses();
  }

  @Query(() => ShippingStatus, {
    name: 'adminShippingStatus',
    nullable: true,
  })
  async adminShippingStatus(
    @Args('id', { type: () => ID }) id: string,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_ORDERS');
    return this.adminConfigService.getShippingStatusById(Number(id));
  }

  @Mutation(() => ShippingStatus, {
    name: 'deleteShippingStatus',
    description: 'Delete a shipping status. Admins only.',
  })
  deleteShippingStatus(
    @CurrentAdmin() adminId: string | undefined,
    @Args('id', { type: () => ID }) id: string,
  ) {
    return this.adminConfigService.deleteShippingStatus(adminId, Number(id));
  }

  @Mutation(() => TransactionsBulkUpsertResult, {
    description:
      'Bulk create/update shipping statuses (rows with id update, without id create). Admins only.',
  })
  bulkUpsertShippingStatuses(
    @CurrentAdmin() adminId: string | undefined,
    @Args('rows', { type: () => [ShippingStatusUpsertRowInput] })
    rows: ShippingStatusUpsertRowInput[],
  ) {
    return this.adminConfigService.bulkUpsertShippingStatuses(adminId, rows);
  }

  // ─── Chilean payment configs ────────────────────────────────────────────────

  @Query(() => ChileanPaymentConfigConnectionEntity, {
    name: 'adminChileanPaymentConfigs',
    description:
      'Paginated payment provider configs (apiKey/secretKey never returned). Admins only.',
  })
  async adminChileanPaymentConfigs(
    @Args() args: ChileanPaymentConfigListArgs,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_SETTINGS');
    return this.adminConfigService.getChileanPaymentConfigs(args);
  }

  @Mutation(() => ChileanPaymentConfig, {
    name: 'deleteChileanPaymentConfig',
    description: 'Delete a payment provider config. Admins only.',
  })
  deleteChileanPaymentConfig(
    @CurrentAdmin() adminId: string | undefined,
    @Args('id', { type: () => ID }) id: string,
  ) {
    return this.adminConfigService.deleteChileanPaymentConfig(
      adminId,
      Number(id),
    );
  }

  @Mutation(() => TransactionsBulkUpsertResult, {
    description:
      'Bulk create/update payment provider configs (rows with id update, without id matched by sellerId+provider). apiKey/secretKey are write-only. Admins only.',
  })
  bulkUpsertChileanPaymentConfigs(
    @CurrentAdmin() adminId: string | undefined,
    @Args('rows', { type: () => [ChileanPaymentConfigUpsertRowInput] })
    rows: ChileanPaymentConfigUpsertRowInput[],
  ) {
    return this.adminConfigService.bulkUpsertChileanPaymentConfigs(
      adminId,
      rows,
    );
  }
}
