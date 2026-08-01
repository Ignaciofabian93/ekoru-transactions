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
import { UnauthorizedException } from '@nestjs/common';
import { MarketplaceDealsService } from './marketplace-deals.service.js';
import { P2PDeal, P2PReputation, ProductRef } from './entities/index.js';
import { Seller } from '../common/entities/index.js';
import { CurrentSeller, CurrentAdmin } from '../common/decorators/index.js';

@Resolver(() => P2PDeal)
export class MarketplaceDealsResolver {
  constructor(private readonly deals: MarketplaceDealsService) {}

  // ─── Proposals ──────────────────────────────────────────────────────────────

  @Mutation(() => P2PDeal, { name: 'proposeSaleDeal' })
  proposeSaleDeal(
    @Args('productId', { type: () => Int }) productId: number,
    @CurrentSeller() buyerId: string,
  ) {
    return this.deals.proposeSale({ productId, buyerId });
  }

  @Mutation(() => P2PDeal, { name: 'proposeExchangeDeal' })
  proposeExchangeDeal(
    @Args('requestedProductId', { type: () => Int }) requestedProductId: number,
    @Args('offeredProductId', { type: () => Int }) offeredProductId: number,
    @CurrentSeller() buyerId: string,
  ) {
    return this.deals.proposeExchange({
      requestedProductId,
      offeredProductId,
      buyerId,
    });
  }

  // ─── Seller responses ─────────────────────────────────────────────────────

  @Mutation(() => P2PDeal, { name: 'acceptDeal' })
  acceptDeal(
    @Args('id', { type: () => Int }) id: number,
    @CurrentSeller() sellerId: string,
  ) {
    return this.deals.acceptDeal({ id, sellerId });
  }

  @Mutation(() => P2PDeal, { name: 'declineDeal' })
  declineDeal(
    @Args('id', { type: () => Int }) id: number,
    @CurrentSeller() sellerId: string,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    return this.deals.declineDeal({ id, sellerId, reason });
  }

  // ─── Confirmation / dispute / cancel ──────────────────────────────────────

  @Mutation(() => P2PDeal, { name: 'confirmDeal' })
  confirmDeal(
    @Args('id', { type: () => Int }) id: number,
    @CurrentSeller() callerId: string,
    @Args('evidenceUrl', { nullable: true }) evidenceUrl?: string,
  ) {
    return this.deals.confirmDeal({ id, callerId, evidenceUrl });
  }

  @Mutation(() => P2PDeal, { name: 'disputeDeal' })
  disputeDeal(
    @Args('id', { type: () => Int }) id: number,
    @Args('reason') reason: string,
    @CurrentSeller() callerId: string,
  ) {
    return this.deals.disputeDeal({ id, callerId, reason });
  }

  @Mutation(() => P2PDeal, { name: 'cancelDeal' })
  cancelDeal(
    @Args('id', { type: () => Int }) id: number,
    @CurrentSeller() callerId: string,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    return this.deals.cancelDeal({ id, callerId, reason });
  }

  /** Admin-only: close a disputed deal. */
  @Mutation(() => P2PDeal, { name: 'resolveDeal' })
  resolveDeal(
    @Args('id', { type: () => Int }) id: number,
    @Args('outcome') outcome: string,
    @CurrentAdmin() adminId: string | undefined,
    @Args('strikeSellerId', { type: () => ID, nullable: true })
    strikeSellerId?: string,
  ) {
    if (!adminId)
      throw new UnauthorizedException('Admin authentication required');
    if (outcome !== 'COMPLETED' && outcome !== 'CANCELLED') {
      throw new UnauthorizedException('Invalid outcome');
    }
    return this.deals.resolveDeal({ id, outcome, strikeSellerId });
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  @Query(() => P2PDeal, { name: 'deal', nullable: true })
  deal(@Args('id', { type: () => Int }) id: number) {
    return this.deals.getDeal(id);
  }

  @Query(() => [P2PDeal], { name: 'myDealsAsBuyer' })
  myDealsAsBuyer(@CurrentSeller() buyerId: string) {
    return this.deals.myDealsAsBuyer(buyerId);
  }

  @Query(() => [P2PDeal], { name: 'myDealsAsSeller' })
  myDealsAsSeller(@CurrentSeller() sellerId: string) {
    return this.deals.myDealsAsSeller(sellerId);
  }

  @Query(() => P2PReputation, { name: 'myP2PReputation' })
  myP2PReputation(@CurrentSeller() sellerId: string) {
    return this.deals.myReputation(sellerId);
  }

  // ─── Federation refs ──────────────────────────────────────────────────────

  @ResolveField(() => Seller)
  buyer(@Parent() deal: P2PDeal): Seller {
    return { id: deal.buyerId };
  }

  @ResolveField(() => Seller)
  seller(@Parent() deal: P2PDeal): Seller {
    return { id: deal.sellerId };
  }

  @ResolveField(() => ProductRef, { nullable: true })
  product(@Parent() deal: P2PDeal): ProductRef | null {
    return deal.productId != null ? { id: deal.productId } : null;
  }

  @ResolveField(() => ProductRef, { nullable: true })
  requestedProduct(@Parent() deal: P2PDeal): ProductRef | null {
    return deal.requestedProductId != null
      ? { id: deal.requestedProductId }
      : null;
  }

  @ResolveField(() => ProductRef, { nullable: true })
  offeredProduct(@Parent() deal: P2PDeal): ProductRef | null {
    return deal.offeredProductId != null ? { id: deal.offeredProductId } : null;
  }
}
