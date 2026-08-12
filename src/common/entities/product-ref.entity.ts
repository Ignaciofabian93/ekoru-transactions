import { ObjectType, Field, Int, Directive } from '@nestjs/graphql';

/**
 * Federation reference to a marketplace Product (owned by ekoru-marketplace).
 * Lets a deal or an order item expose its product so clients can select
 * name/images/price without this subgraph storing them. Mirrors the Seller ref
 * in `seller.entity.ts`.
 */
@ObjectType('Product')
@Directive('@key(fields: "id")')
@Directive('@extends')
export class ProductRef {
  @Field(() => Int)
  @Directive('@external')
  id: number;
}

/**
 * Same idea for a StoreProduct (owned by ekoru-stores). An order item points at
 * exactly one of the two catalogues, so both refs are nullable on OrderItem.
 */
@ObjectType('StoreProduct')
@Directive('@key(fields: "id")')
@Directive('@extends')
export class StoreProductRef {
  @Field(() => Int)
  @Directive('@external')
  id: number;
}
