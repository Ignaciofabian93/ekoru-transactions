import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Seller } from '../common/entities/index.js';
import { OrdersService } from './orders.service.js';

/**
 * `Seller.canReceivePayments` (TRX-4): whether buyers can pay this seller
 * online now. The web hides buy buttons when it is false; createOrder refuses
 * the order anyway.
 */
@Resolver(() => Seller)
export class SellerPaymentsResolver {
  constructor(private readonly orders: OrdersService) {}

  @ResolveField(() => Boolean, {
    description:
      'Buyers can pay this seller online now: it has an active payout account.',
  })
  canReceivePayments(@Parent() seller: Seller): Promise<boolean> {
    return this.orders.canReceivePayments(seller.id);
  }
}
