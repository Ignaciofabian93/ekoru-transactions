import { InputType, Field, Int } from '@nestjs/graphql';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class OrderItemInput {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  productId?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  storeProductId?: number;

  @Field(() => Int)
  @IsNumber()
  @Min(1)
  quantity: number;

  @Field(() => Int)
  @IsNumber()
  @Min(0)
  price: number;
}

@InputType()
export class CreateOrderInput {
  @Field(() => String)
  @IsString()
  sellerId: string;

  @Field(() => [OrderItemInput])
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInput)
  items: OrderItemInput[];
}
