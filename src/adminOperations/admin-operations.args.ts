import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  OrderStatus,
  P2PStatus,
  PaymentStatus,
  PaymentType,
} from '../graphql/enums/index.js';

/** Page, page size and a creation-date window, shared by every admin list. */
@ArgsType()
class AdminListArgs {
  @Field(() => Int, { defaultValue: 1 })
  @IsInt()
  @Min(1)
  page: number = 1;

  @Field(() => Int, { defaultValue: 20 })
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 20;

  @Field(() => Date, { nullable: true, description: 'Created on or after.' })
  @IsOptional()
  @IsDate()
  from?: Date;

  @Field(() => Date, { nullable: true, description: 'Created before.' })
  @IsOptional()
  @IsDate()
  to?: Date;

  @Field(() => String, {
    nullable: true,
    description: "Either party's email (buyer or seller, payer or receiver).",
  })
  @IsOptional()
  @IsString()
  email?: string;
}

@ArgsType()
export class AdminOrdersArgs extends AdminListArgs {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  orderId?: number;

  @Field(() => OrderStatus, { nullable: true })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  sellerId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  buyerId?: string;
}

@ArgsType()
export class AdminPaymentsArgs extends AdminListArgs {
  @Field(() => PaymentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @Field(() => PaymentType, { nullable: true })
  @IsOptional()
  @IsEnum(PaymentType)
  paymentType?: PaymentType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  payerId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  receiverId?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  orderId?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  quotationId?: number;

  @Field(() => String, {
    nullable: true,
    description: "The provider's reference (Webpay buy order, Khipu id).",
  })
  @IsOptional()
  @IsString()
  externalId?: string;
}

@ArgsType()
export class AdminDealsArgs extends AdminListArgs {
  @Field(() => P2PStatus, { nullable: true })
  @IsOptional()
  @IsEnum(P2PStatus)
  status?: P2PStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  sellerId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  buyerId?: string;
}
