import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { OrdersService } from './orders.service.js';
import { Order, OrderConnection, OrderItem } from './entities/index.js';
import { CreateOrderInput, UpdateShippingInput } from './dto/index.js';
import { CurrentSeller } from '../common/decorators/index.js';
import { ProductRef, StoreProductRef } from '../common/entities/index.js';

@Resolver(() => Order)
export class OrdersResolver {
  constructor(private readonly ordersService: OrdersService) {}

  @Query(() => Order, { name: 'getOrder', nullable: true })
  async getOrder(@Args('id', { type: () => ID }) id: string) {
    return this.ordersService.getOrder(parseInt(id, 10));
  }

  @Query(() => OrderConnection, { name: 'getOrdersBySeller' })
  async getOrdersBySeller(
    @Args('sellerId', { type: () => ID }) sellerId: string,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
  ) {
    return this.ordersService.getOrdersBySeller({ sellerId, page, pageSize });
  }

  /**
   * Buyer-side order history. The authenticated seller is the buyer here.
   * The frontend confirmation screen links the buyer's "View my orders"
   * button to a page that calls this.
   */
  @Query(() => OrderConnection, { name: 'getOrdersByBuyer' })
  async getOrdersByBuyer(
    @CurrentSeller() buyerId: string,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
  ) {
    return this.ordersService.getOrdersByBuyer({ buyerId, page, pageSize });
  }

  /**
   * Creates a PENDING_PAYMENT order with server-computed totals. Anyone
   * trying to pass a sellerId or per-item price is ignored — buyerId comes
   * from the JWT, sellerId + price come from the marketplace subgraph.
   */
  @Mutation(() => Order)
  async createOrder(
    @Args('input') input: CreateOrderInput,
    @CurrentSeller() buyerId: string,
  ) {
    return this.ordersService.createOrder({ input, buyerId });
  }

  @Mutation(() => Order)
  async updateShipping(@Args('input') input: UpdateShippingInput) {
    return this.ordersService.updateShipping(input);
  }
}

/**
 * Turns the stored catalogue ids into federation refs, so a client can pull the
 * product name and images off an order line in the same round trip. Same shape
 * as the deal refs in `marketplace-deals.resolver.ts`.
 */
@Resolver(() => OrderItem)
export class OrderItemResolver {
  @ResolveField(() => ProductRef, { nullable: true })
  product(@Parent() item: OrderItem): ProductRef | null {
    return item.productId != null ? { id: item.productId } : null;
  }

  @ResolveField(() => StoreProductRef, { nullable: true })
  storeProduct(@Parent() item: OrderItem): StoreProductRef | null {
    return item.storeProductId != null ? { id: item.storeProductId } : null;
  }
}
