import { ObjectType, Field, ID, Int, Directive } from '@nestjs/graphql';

@ObjectType()
@Directive('@key(fields: "id")')
export class OrderItem {
  @Field(() => ID)
  id: number;

  @Field(() => Int)
  orderId: number;

  /** Marketplace (used/exchangeable) product – nullable */
  @Field(() => Int, { nullable: true })
  productId?: number;

  /** Store (new ecommerce) product – nullable */
  @Field(() => Int, { nullable: true })
  storeProductId?: number;

  @Field(() => Int)
  quantity: number;

  /** Price captured at the time of the order (in CLP) */
  @Field(() => Int)
  price: number;

  @Field(() => Date)
  createdAt: Date;
}
