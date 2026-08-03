import { Field, InputType, ID } from '@nestjs/graphql';
import { IsEnum, IsOptional } from 'class-validator';
import { ShippingStage } from '../../graphql/enums/index.js';

/**
 * Bulk upsert row for `ShippingStatus` (a shipping-stage lookup row):
 * - `id` present → update that row
 * - no `id`      → create (status required)
 */
@InputType()
export class ShippingStatusUpsertRowInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  id?: string | number;

  @Field(() => ShippingStage, {
    nullable: true,
    description: 'Shipping stage. Required when creating.',
  })
  @IsOptional()
  @IsEnum(ShippingStage)
  status?: ShippingStage;
}
