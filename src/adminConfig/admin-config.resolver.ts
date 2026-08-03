import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { AdminConfigService } from './admin-config.service.js';
import { TransactionFee } from '../transactions/entities/index.js';
import { TransactionsBulkUpsertResult } from '../common/bulk/index.js';
import { TransactionFeeUpsertRowInput } from './dto/index.js';
import { CurrentAdmin } from '../common/decorators/index.js';

/** Platform-admin CRUD for the transactions subgraph config tables. */
@Resolver()
export class AdminConfigResolver {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  // ─── Transaction fees ───────────────────────────────────────────────────────

  @Query(() => [TransactionFee], { name: 'adminTransactionFees' })
  adminTransactionFees() {
    return this.adminConfigService.getTransactionFees();
  }

  @Query(() => TransactionFee, {
    name: 'adminTransactionFee',
    nullable: true,
  })
  adminTransactionFee(@Args('id', { type: () => ID }) id: string) {
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
}
