import { ObjectType, Field, ID, Int, Directive } from '@nestjs/graphql';
import { ExchangeStatus } from '../../graphql/enums/index.js';

@ObjectType()
@Directive('@key(fields: "id")')
export class Exchange {
  @Field(() => ID)
  id: number;

  @Field(() => Int)
  transactionId: number;

  @Field(() => Int)
  offeredProductId: number;

  @Field(() => Int)
  requestedProductId: number;

  @Field(() => ExchangeStatus)
  status: ExchangeStatus;

  @Field(() => String, { nullable: true })
  notes?: string;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date, { nullable: true })
  completedAt?: Date;
}
