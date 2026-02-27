import { Resolver, Query, Mutation, Args, Int, ID } from '@nestjs/graphql';
import { TransactionsService } from './transactions.service.js';
import {
  Transaction,
  TransactionFee,
  Exchange,
  TransactionConnection,
} from './entities/index.js';
import { CreateTransactionInput, CreateExchangeInput } from './dto/index.js';
import {
  TransactionKind,
  ExchangeStatus,
} from '../graphql/enums/index.js';

@Resolver(() => Transaction)
export class TransactionsResolver {
  constructor(
    private readonly transactionsService: TransactionsService,
  ) {}

  @Query(() => Transaction, { name: 'getTransaction', nullable: true })
  async getTransaction(@Args('id', { type: () => ID }) id: string) {
    return this.transactionsService.getTransaction(parseInt(id, 10));
  }

  @Query(() => TransactionConnection, { name: 'getTransactionsBySeller' })
  async getTransactionsBySeller(
    @Args('sellerId', { type: () => ID }) sellerId: string,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('kind', { type: () => TransactionKind, nullable: true })
    kind?: TransactionKind,
  ) {
    return this.transactionsService.getTransactionsBySeller(
      sellerId,
      page,
      pageSize,
      kind,
    );
  }

  @Query(() => [TransactionFee], { name: 'getTransactionFees' })
  async getTransactionFees() {
    return this.transactionsService.getTransactionFees();
  }

  @Mutation(() => Transaction)
  async createTransaction(@Args('input') input: CreateTransactionInput) {
    return this.transactionsService.createTransaction(input);
  }

  @Mutation(() => Exchange)
  async createExchange(@Args('input') input: CreateExchangeInput) {
    return this.transactionsService.createExchange(input);
  }

  @Mutation(() => Exchange)
  async updateExchangeStatus(
    @Args('id', { type: () => ID }) id: string,
    @Args('status', { type: () => ExchangeStatus }) status: ExchangeStatus,
  ) {
    return this.transactionsService.updateExchangeStatus(
      parseInt(id, 10),
      status,
    );
  }
}
