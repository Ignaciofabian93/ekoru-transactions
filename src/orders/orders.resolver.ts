import { Resolver, Query, Mutation, Args, Int, ID } from '@nestjs/graphql';
import { OrdersService } from './orders.service.js';
import { Order, OrderConnection } from './entities/index.js';
import { CreateOrderInput, UpdateShippingInput } from './dto/index.js';

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
    return this.ordersService.getOrdersBySeller(sellerId, page, pageSize);
  }

  @Mutation(() => Order)
  async createOrder(@Args('input') input: CreateOrderInput) {
    return this.ordersService.createOrder(input);
  }

  @Mutation(() => Order)
  async updateShipping(@Args('input') input: UpdateShippingInput) {
    return this.ordersService.updateShipping(input);
  }
}
