import { ObjectType, Field } from '@nestjs/graphql';
import { Transaction } from './transaction.entity.js';
import { PageInfo } from '../../common/entities/index.js';

@ObjectType()
export class TransactionConnection {
  @Field(() => [Transaction])
  nodes: Transaction[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}
