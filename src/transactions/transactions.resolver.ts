import { Resolver, Query, Args, Int, ID } from '@nestjs/graphql';
import { TransactionsService } from './transactions.service.js';
import {
  Transaction,
  TransactionFee,
  TransactionConnection,
} from './entities/index.js';
import { TransactionKind } from '../graphql/enums/index.js';
import { CurrentAdmin, CurrentSeller } from '../common/decorators/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertPartyOrAdmin, sellerScope } from '../common/admin-access.js';

/**
 * The eco-points ledger (Transaction rows), written by deals and orders when
 * points are awarded. Reads are for the seller the row belongs to, or a
 * platform admin with VIEW_TRANSACTIONS (TRX-1).
 *
 * The public createTransaction, createExchange and updateExchangeStatus
 * mutations are gone: no client called them, and they let anyone write ledger
 * rows (and points history) for any seller.
 */
@Resolver(() => Transaction)
export class TransactionsResolver {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Query(() => Transaction, { name: 'getTransaction', nullable: true })
  async getTransaction(
    @Args('id', { type: () => ID }) id: string,
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const tx = await this.transactionsService.getTransaction(parseInt(id, 10));
    await assertPartyOrAdmin(this.prisma, {
      sellerId,
      adminId,
      parties: [tx.sellerId],
      permission: 'VIEW_TRANSACTIONS',
    });
    return tx;
  }

  /** A seller's own ledger; a platform admin names the seller. */
  @Query(() => TransactionConnection, { name: 'getTransactionsBySeller' })
  async getTransactionsBySeller(
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('sellerId', { type: () => ID, nullable: true }) requested?: string,
    @Args('kind', { type: () => TransactionKind, nullable: true })
    kind?: TransactionKind,
    @CurrentSeller() sessionSellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const sellerId = await sellerScope(this.prisma, {
      sellerId: sessionSellerId,
      adminId,
      requested,
      permission: 'VIEW_TRANSACTIONS',
    });
    return this.transactionsService.getTransactionsBySeller({
      sellerId,
      page,
      pageSize,
      kind,
    });
  }

  /** The commission schedule: public, it is what sellers are charged. */
  @Query(() => [TransactionFee], { name: 'getTransactionFees' })
  async getTransactionFees() {
    return this.transactionsService.getTransactionFees();
  }
}
