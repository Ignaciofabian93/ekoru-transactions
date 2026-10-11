import { InputType, Field, ID } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ShippingStage } from '../../graphql/enums/index.js';

@InputType()
export class UpdateShippingInput {
  @Field(() => ID)
  @IsString()
  orderId: string;

  @Field(() => ShippingStage)
  @IsEnum(ShippingStage)
  stage: ShippingStage;

  /**
   * Carrier and tracking number, free text. Kept only when the order moves to
   * SHIPPED; ignored for every other stage (WEB-1).
   */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  trackingInfo?: string;
}
