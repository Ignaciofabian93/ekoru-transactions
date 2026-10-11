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
import { CurrentAdmin, CurrentSeller } from '../common/decorators/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertPartyOrAdmin,
  requireSeller,
  sellerScope,
} from '../common/admin-access.js';
import { ProductRef, StoreProductRef } from '../common/entities/index.js';
import { OrderStatus, ShippingStage } from '../graphql/enums/index.js';

@Resolver(() => Order)
export class OrdersResolver {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly prisma: PrismaService,
  ) {}

  /** The order's buyer or seller, or a platform admin who oversees orders. */
  @Query(() => Order, { name: 'getOrder', nullable: true })
  async getOrder(
    @Args('id', { type: () => ID }) id: string,
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const order = await this.ordersService.getOrder(parseInt(id, 10));
    await assertPartyOrAdmin(this.prisma, {
      sellerId,
      adminId,
      parties: [order.buyerId, order.sellerId],
      permission: ['MANAGE_ORDERS', 'VIEW_TRANSACTIONS'],
    });
    return order;
  }

  /**
   * Orders a seller received. A seller always gets their own (`sellerId` may
   * be left out); a platform admin who oversees orders names the seller.
   */
  @Query(() => OrderConnection, { name: 'getOrdersBySeller' })
  async getOrdersBySeller(
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 10 }) pageSize: number,
    @Args('sellerId', { type: () => ID, nullable: true })
    requested?: string,
    @Args('status', { type: () => OrderStatus, nullable: true })
    status?: OrderStatus,
    @Args('stage', { type: () => ShippingStage, nullable: true })
    stage?: ShippingStage,
    @CurrentSeller() sessionSellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const sellerId = await sellerScope(this.prisma, {
      sellerId: sessionSellerId,
      adminId,
      requested,
      permission: ['MANAGE_ORDERS', 'VIEW_TRANSACTIONS'],
    });
    return this.ordersService.getOrdersBySeller({
      sellerId,
      page,
      pageSize,
      status,
      stage,
    });
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
    // Without a session the filter used to be `buyerId: undefined`, which
    // Prisma drops, so a signed-out call listed every order on the platform.
    return this.ordersService.getOrdersByBuyer({
      buyerId: requireSeller(buyerId),
      page,
      pageSize,
    });
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

  /** The order's seller, or a platform admin with MANAGE_ORDERS. */
  @Mutation(() => Order)
  async updateShipping(
    @Args('input') input: UpdateShippingInput,
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    return this.ordersService.updateShipping({ input, sellerId, adminId });
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
