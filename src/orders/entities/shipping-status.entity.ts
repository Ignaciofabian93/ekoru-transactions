import { ObjectType, Field, ID } from '@nestjs/graphql';
import { ShippingStage } from '../../graphql/enums/index.js';

@ObjectType()
export class ShippingStatus {
  @Field(() => ID)
  id: number;

  @Field(() => ShippingStage)
  status: ShippingStage;
}
