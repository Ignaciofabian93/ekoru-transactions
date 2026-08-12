import { ObjectType, Field, ID, Int, Directive } from '@nestjs/graphql';
import { ProductRef, StoreProductRef } from '../../common/entities/index.js';

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

  /**
   * Federated refs so a client can render the line with its name and image
   * without this subgraph storing catalogue data. Exactly one is non-null,
   * matching whichever of `productId` / `storeProductId` is set.
   */
  @Field(() => ProductRef, { nullable: true })
  product?: ProductRef | null;

  @Field(() => StoreProductRef, { nullable: true })
  storeProduct?: StoreProductRef | null;
}
