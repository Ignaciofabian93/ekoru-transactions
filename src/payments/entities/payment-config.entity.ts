import { ObjectType, Field, ID, Directive } from '@nestjs/graphql';
import {
  ChileanPaymentProvider,
  PaymentEnvironment,
} from '../../graphql/enums/index.js';

@ObjectType()
@Directive('@key(fields: "id")')
export class ChileanPaymentConfig {
  @Field(() => ID)
  id: number;

  @Field(() => String)
  sellerId: string;

  @Field(() => ChileanPaymentProvider)
  provider: ChileanPaymentProvider;

  /** merchantId is returned only to the owning seller */
  @Field(() => String, { nullable: true })
  merchantId?: string;

  @Field(() => PaymentEnvironment)
  environment: PaymentEnvironment;

  @Field(() => Boolean)
  isActive: boolean;

  @Field(() => String, { nullable: true })
  webhookUrl?: string;

  @Field(() => String, { nullable: true })
  returnUrl?: string;

  @Field(() => String, { nullable: true })
  cancelUrl?: string;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt: Date;
}
