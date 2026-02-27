import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';
import {
  ChileanPaymentProvider,
  PaymentType,
} from '../../graphql/enums/index.js';

@InputType()
export class CreatePaymentInput {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  orderId?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  quotationId?: number;

  @Field(() => Float)
  @IsNumber()
  @IsPositive()
  amount: number;

  /** Default CLP – Chilean peso */
  @Field(() => String, { defaultValue: 'CLP' })
  @IsOptional()
  @IsString()
  currency: string = 'CLP';

  @Field(() => ChileanPaymentProvider)
  @IsEnum(ChileanPaymentProvider)
  paymentProvider: ChileanPaymentProvider;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => String)
  @IsString()
  payerId: string;

  @Field(() => String)
  @IsString()
  receiverId: string;

  @Field(() => PaymentType)
  @IsEnum(PaymentType)
  paymentType: PaymentType;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  chileanConfigId: number;
}
