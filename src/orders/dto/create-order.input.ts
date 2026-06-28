import { InputType, Field, Int } from '@nestjs/graphql';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ShippingMethod } from '../../graphql/enums/index.js';

/**
 * Items the buyer wants to purchase. Only references and quantity — the server
 * looks up the canonical price from the marketplace/stores subgraph and never
 * trusts a client-supplied price.
 */
@InputType()
export class OrderItemInput {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  productId?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  storeProductId?: number;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity: number;
}

@InputType()
export class ShippingAddressInput {
  @Field(() => String)
  @IsString()
  @MaxLength(120)
  recipientName: string;

  @Field(() => String)
  @IsString()
  @MaxLength(20)
  phone: string;

  @Field(() => Int)
  @IsInt()
  countryId: number;

  @Field(() => Int)
  @IsInt()
  regionId: number;

  @Field(() => Int)
  @IsInt()
  cityId: number;

  @Field(() => Int)
  @IsInt()
  countyId: number;

  @Field(() => String)
  @IsString()
  @MaxLength(200)
  street: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  zipCode?: string;
}

@InputType()
export class CreateOrderInput {
  @Field(() => [OrderItemInput])
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInput)
  items: OrderItemInput[];

  @Field(() => ShippingMethod)
  @IsEnum(ShippingMethod)
  shippingMethod: ShippingMethod;

  /**
   * Required when `shippingMethod` is `DELIVERED_TO_HOME` or `CARRIER`.
   * Ignored for in-house / mid-point pickup.
   */
  @Field(() => ShippingAddressInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShippingAddressInput)
  shippingAddress?: ShippingAddressInput;

  /** ISO 4217 — currently restricted to "CLP" (Chile-first launch). */
  @Field(() => String, { defaultValue: 'CLP' })
  @IsOptional()
  @IsString()
  currency: string = 'CLP';
}