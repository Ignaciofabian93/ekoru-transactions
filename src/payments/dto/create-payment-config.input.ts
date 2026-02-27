import { InputType, Field } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';
import {
  ChileanPaymentProvider,
  PaymentEnvironment,
} from '../../graphql/enums/index.js';

@InputType()
export class CreatePaymentConfigInput {
  @Field(() => String)
  @IsString()
  sellerId: string;

  @Field(() => ChileanPaymentProvider)
  @IsEnum(ChileanPaymentProvider)
  provider: ChileanPaymentProvider;

  /** Merchant/receiver ID for Khipu or commerce code for Webpay */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  merchantId?: string;

  /**
   * API key for Khipu (receiver key) or Webpay (commerce key).
   * Never returned in queries – write-only.
   */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  apiKey?: string;

  /**
   * Secret key used for Webpay signing.
   * Never returned in queries – write-only.
   */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  secretKey?: string;

  @Field(() => PaymentEnvironment, { defaultValue: PaymentEnvironment.SANDBOX })
  @IsOptional()
  @IsEnum(PaymentEnvironment)
  environment: PaymentEnvironment = PaymentEnvironment.SANDBOX;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUrl()
  webhookUrl?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUrl()
  returnUrl?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUrl()
  cancelUrl?: string;

  @Field(() => Boolean, { defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive: boolean = true;
}
