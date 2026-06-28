import { Resolver, Query, Mutation, Args, Int, ID } from '@nestjs/graphql';
import { OrdersService } from './orders.service.js';
import { Order, OrderConnection } from './entities/index.js';
import { CreateOrderInput, UpdateShippingInput } from './dto/index.js';
import { CurrentSeller } from '../common/decorators/index.js';

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
