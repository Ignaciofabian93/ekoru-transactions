import { ObjectType, Field, ID, Int, Directive } from '@nestjs/graphql';
import { TransactionKind } from '../../graphql/enums/index.js';
import { Seller } from '../../common/entities/index.js';
import { TransactionFee } from './transaction-fee.entity.js';
import { Exchange } from './exchange.entity.js';

@ObjectType()
@Directive('@key(fields: "id")')
export class Transaction {
  @Field(() => ID)
  id: number;

  @Field(() => TransactionKind)
  kind: TransactionKind;

  /** Eco-points earned for this transaction */
  @Field(() => Int)
  pointsCollected: number;

  @Field(() => String)
  sellerId: string;

  @Field(() => Int, { nullable: true })
  transactionFeeId?: number;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Seller, { nullable: true })
  seller?: Seller;

  @Field(() => TransactionFee, { nullable: true })
  transactionFee?: TransactionFee;

  @Field(() => Exchange, { nullable: true })
  exchange?: Exchange;
}
