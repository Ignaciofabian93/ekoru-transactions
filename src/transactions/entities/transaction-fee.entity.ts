import { ObjectType, Field, ID, Float, Directive } from '@nestjs/graphql';
import { SellerType } from '../../graphql/enums/index.js';

@ObjectType()
@Directive('@key(fields: "id")')
export class TransactionFee {
  @Field(() => ID)
  id: number;

  @Field(() => SellerType)
  sellerTypeFee: SellerType;

  @Field(() => Float)
  feePercentage: number;

  @Field(() => String)
  description: string;
}
