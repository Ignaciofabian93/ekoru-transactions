import { ObjectType, Field, ID, Int, Float, Directive } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import {
  ChileanPaymentProvider,
  PaymentStatus,
  PaymentType,
} from '../../graphql/enums/index.js';
import { Seller } from '../../common/entities/index.js';

@ObjectType()
@Directive('@key(fields: "id")')
export class Payment {
  @Field(() => ID)
  id: number;

  @Field(() => Int, { nullable: true })
  orderId?: number;

  @Field(() => Int, { nullable: true })
  quotationId?: number;

  @Field(() => Float)
  amount: number;

  /** ISO 4217 currency code – default CLP for Chile */
  @Field(() => String)
  currency: string;

  @Field(() => PaymentStatus)
  status: PaymentStatus;

  @Field(() => ChileanPaymentProvider)
  paymentProvider: ChileanPaymentProvider;

  @Field(() => String, { nullable: true })
  externalId?: string;

  @Field(() => String, { nullable: true })
  externalToken?: string;

  @Field(() => String, { nullable: true })
  description?: string;

  @Field(() => Float, { nullable: true })
  fees?: number;

  @Field(() => Float, { nullable: true })
  netAmount?: number;

  @Field(() => String)
  payerId: string;

  @Field(() => String)
  receiverId: string;

  @Field(() => String, { nullable: true })
  failureReason?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => PaymentType)
  paymentType: PaymentType;

  @Field(() => Int)
  chileanConfigId: number;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt: Date;

  @Field(() => Date, { nullable: true })
  processedAt?: Date;

  @Field(() => Date, { nullable: true })
  refundedAt?: Date;

  @Field(() => Seller, { nullable: true })
  payer?: Seller;

  @Field(() => Seller, { nullable: true })
  receiver?: Seller;
}
