import { ObjectType, Field, Int, Directive } from '@nestjs/graphql';

/**
 * Federation reference to a marketplace Product (owned by ekoru-marketplace).
 * Lets a deal expose its item(s) so clients can select name/images/price
 * without this subgraph storing them. Mirrors the Seller ref in
 * `common/entities/seller.entity.ts`.
 */
@ObjectType('Product')
@Directive('@key(fields: "id")')
@Directive('@extends')
export class ProductRef {
  @Field(() => Int)
  @Directive('@external')
  id: number;
}
