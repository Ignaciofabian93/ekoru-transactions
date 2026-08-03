import { Field, InputType, ID, Float } from '@nestjs/graphql';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { SellerType } from '../../graphql/enums/index.js';

/**
 * Bulk upsert row for `TransactionFee`, designed for XLSX round-trips and
 * single-row edits from the admin panel:
 * - `id` present → update that row (only the provided fields change)
 * - no `id`      → create (all fields required)
 *
 * Omitted fields are left untouched on update.
 */
@InputType()
export class TransactionFeeUpsertRowInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  id?: string | number;

  @Field(() => SellerType, {
    nullable: true,
    description: 'Seller type this fee applies to. Required when creating.',
  })
  @IsOptional()
  @IsEnum(SellerType)
  sellerTypeFee?: SellerType;

  @Field(() => Float, {
    nullable: true,
    description: 'Fee as a fraction (e.g. 0.05 = 5%). Required when creating.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  feePercentage?: number;

  @Field(() => String, {
    nullable: true,
    description: 'Human-readable note. Required when creating.',
  })
  @IsOptional()
  @IsString()
  description?: string;
}
