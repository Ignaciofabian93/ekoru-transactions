import { ObjectType, Field, ID, Int, Directive } from '@nestjs/graphql';
import { Seller } from '../../common/entities/index.js';
import { OrderStatus, ShippingMethod } from '../../graphql/enums/index.js';
import { ShippingStatus } from './shipping-status.entity.js';
import { OrderItem } from './order-item.entity.js';
import { ShippingAddress } from './shipping-address.entity.js';

@ObjectType()
@Directive('@key(fields: "id")')
export class Order {
  @Field(() => ID)
  id: number;

  /** Authenticated seller who placed the order. */
  @Field(() => String)
  buyerId: string;

  /** Seller who fulfills the order. */
  @Field(() => String)
  sellerId: string;

  @Field(() => OrderStatus)
  status: OrderStatus;

  /** Sum of `OrderItem.price * quantity`. Integer in the order currency's minor unit (or major for CLP). */
  @Field(() => Int)
  subtotal: number;

  @Field(() => Int)
  shippingCost: number;

  @Field(() => Int)
  taxAmount: number;

  /** subtotal + shippingCost + taxAmount, snapshot at order creation time. */
  @Field(() => Int)
  total: number;

  /** ISO 4217 — defaults to CLP. */
  @Field(() => String)
  currency: string;

  @Field(() => ShippingMethod)
  shippingMethod: ShippingMethod;

  @Field(() => Int, { nullable: true })
  shippingAddressId?: number;

  @Field(() => Int)
  shippingStatusId: number;

  @Field(() => Int)
  version: number;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt: Date;

  @Field(() => ShippingAddress, { nullable: true })
  shippingAddress?: ShippingAddress;

  @Field(() => ShippingStatus, { nullable: true })
  shippingStatus?: ShippingStatus;

  @Field(() => [OrderItem], { nullable: true })
  orderItems?: OrderItem[];

  /** Federated reference — resolved by ekoru-users. */
  @Field(() => Seller, { nullable: true })
  seller?: Seller;

  /** Federated reference — resolved by ekoru-users. */
  @Field(() => Seller, { nullable: true })
  buyer?: Seller;
}
