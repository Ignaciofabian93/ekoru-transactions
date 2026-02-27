import { ObjectType, Field, ID, Int, Float, Directive } from '@nestjs/graphql';
import { RefundStatus } from '../../graphql/enums/index.js';

@ObjectType()
@Directive('@key(fields: "id")')
export class PaymentRefund {
  @Field(() => ID)
  id: number;

  @Field(() => Int)
  paymentId: number;

  @Field(() => Float)
  amount: number;

  @Field(() => String)
  reason: string;

  @Field(() => RefundStatus)
  status: RefundStatus;

  @Field(() => String, { nullable: true })
  externalId?: string;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date, { nullable: true })
  processedAt?: Date;
}
