import { ArgsType, Field, InputType, ID, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  ChileanPaymentProvider,
  PaymentEnvironment,
} from '../../graphql/enums/index.js';

@ArgsType()
export class ChileanPaymentConfigListArgs {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  id?: number;

  @Field(() => Int, { defaultValue: 1 })
  @IsInt()
  @Min(1)
  page: number;

  @Field(() => Int, { defaultValue: 50 })
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize: number;

  @Field(() => String, {
    nullable: true,
    description: 'Filters configs whose sellerId contains this text',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @Field(() => ChileanPaymentProvider, { nullable: true })
  @IsOptional()
  @IsEnum(ChileanPaymentProvider)
  provider?: ChileanPaymentProvider;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Bulk upsert row for `ChileanPaymentConfig`. `apiKey`/`secretKey` are
 * WRITE-ONLY — set here when provided, never returned in reads. Rows without an
 * id are matched by the unique (sellerId, provider).
 */
@InputType()
export class ChileanPaymentConfigUpsertRowInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  id?: string | number;

  @Field(() => String, {
    nullable: true,
    description: 'Owner seller. Required when creating (no id).',
  })
  @IsOptional()
  @IsString()
  sellerId?: string;

  @Field(() => ChileanPaymentProvider, {
    nullable: true,
    description: 'Payment provider. Required when creating (no id).',
  })
  @IsOptional()
  @IsEnum(ChileanPaymentProvider)
  provider?: ChileanPaymentProvider;

  @Field(() => String, { nullable: true })
  @IsOptional()
  merchantId?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Write-only secret. Blank leaves the stored value unchanged.',
  })
  @IsOptional()
  @IsString()
  apiKey?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Write-only secret. Blank leaves the stored value unchanged.',
  })
  @IsOptional()
  @IsString()
  secretKey?: string | null;

  @Field(() => PaymentEnvironment, { nullable: true })
  @IsOptional()
  @IsEnum(PaymentEnvironment)
  environment?: PaymentEnvironment;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => String, { nullable: true })
  @IsOptional()
  webhookUrl?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  returnUrl?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  cancelUrl?: string | null;
}
