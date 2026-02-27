import { ObjectType, Field, ID, Int, Directive } from '@nestjs/graphql';
import { Seller } from '../../common/entities/index.js';
import { ShippingStatus } from './shipping-status.entity.js';
import { OrderItem } from './order-item.entity.js';

@ObjectType()
@Directive('@key(fields: "id")')
export class Order {
  @Field(() => ID)
  id: number;

  @Field(() => String)
  sellerId: string;

  @Field(() => Int)
  shippingStatusId: number;

  @Field(() => Int)
  version: number;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt: Date;

  @Field(() => ShippingStatus, { nullable: true })
  shippingStatus?: ShippingStatus;

  @Field(() => [OrderItem], { nullable: true })
  orderItems?: OrderItem[];

  @Field(() => Seller, { nullable: true })
  seller?: Seller;
}
