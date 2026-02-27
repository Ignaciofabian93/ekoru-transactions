import { InputType, Field, ID } from '@nestjs/graphql';
import { IsEnum, IsString } from 'class-validator';
import { ShippingStage } from '../../graphql/enums/index.js';

@InputType()
export class UpdateShippingInput {
  @Field(() => ID)
  @IsString()
  orderId: string;

  @Field(() => ShippingStage)
  @IsEnum(ShippingStage)
  stage: ShippingStage;
}
