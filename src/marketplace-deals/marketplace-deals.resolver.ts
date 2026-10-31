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
import { MarketplaceDealsService } from './marketplace-deals.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  assertAdminCan,
  assertPartyOrAdmin,
  requireSeller,
} from '../common/admin-access.js';
import { BadRequestError, NotFoundError } from '../common/exceptions/index.js';
import { P2PDeal, P2PDealSettings, P2PReputation } from './entities/index.js';
import { Seller, ProductRef } from '../common/entities/index.js';
import { P2PStatus } from '../graphql/enums/index.js';
import { CurrentSeller, CurrentAdmin } from '../common/decorators/index.js';

@Resolver(() => P2PDeal)
export class MarketplaceDealsResolver {
  constructor(
    private readonly deals: MarketplaceDealsService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Proposals ──────────────────────────────────────────────────────────────

  @Mutation(() => P2PDeal, { name: 'proposeSaleDeal' })
  proposeSaleDeal(
    @Args('productId', { type: () => Int }) productId: number,
    @CurrentSeller() buyerId: string,
    @Args('message', { nullable: true }) message?: string,
  ) {
    return this.deals.proposeSale({ productId, buyerId, message });
  }

  @Mutation(() => P2PDeal, { name: 'proposeExchangeDeal' })
  proposeExchangeDeal(
    @Args('requestedProductId', { type: () => Int }) requestedProductId: number,
    @Args('offeredProductId', { type: () => Int }) offeredProductId: number,
    @CurrentSeller() buyerId: string,
    @Args('message', { nullable: true }) message?: string,
  ) {
    return this.deals.proposeExchange({
      requestedProductId,
      offeredProductId,
      buyerId,
      message,
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
    @Args('compensationSettled', { type: () => Boolean, nullable: true })
    compensationSettled?: boolean,
  ) {
    return this.deals.confirmDeal({
      id,
      callerId,
      evidenceUrl,
      compensationSettled,
    });
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

  /** Close a disputed deal: platform admins with MANAGE_ORDERS (SEC-8). */
  @Mutation(() => P2PDeal, { name: 'resolveDeal' })
  async resolveDeal(
    @Args('id', { type: () => Int }) id: number,
    @Args('outcome') outcome: string,
    @CurrentAdmin() adminId: string | undefined,
    @Args('strikeSellerId', { type: () => ID, nullable: true })
    strikeSellerId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_ORDERS');
    if (outcome !== 'COMPLETED' && outcome !== 'CANCELLED') {
      throw new BadRequestError('Invalid outcome');
    }
    return this.deals.resolveDeal({ id, outcome, strikeSellerId });
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /** The deal's buyer or seller, or a platform admin who handles disputes. */
  @Query(() => P2PDeal, { name: 'deal', nullable: true })
  async deal(
    @Args('id', { type: () => Int }) id: number,
    @CurrentSeller() sellerId?: string,
    @CurrentAdmin() adminId?: string,
  ) {
    const deal = await this.deals.getDeal(id);
    if (!deal) throw new NotFoundError('Trato no encontrado');
    await assertPartyOrAdmin(this.prisma, {
      sellerId,
      adminId,
      parties: [deal.buyerId, deal.sellerId],
      permission: ['MANAGE_ORDERS', 'VIEW_TRANSACTIONS'],
    });
    return deal;
  }

  // Without a session these filtered on `undefined`, which Prisma drops, so a
  // signed-out call listed every deal on the platform.

  @Query(() => [P2PDeal], { name: 'myDealsAsBuyer' })
  myDealsAsBuyer(@CurrentSeller() buyerId: string) {
    return this.deals.myDealsAsBuyer(requireSeller(buyerId));
  }

  @Query(() => [P2PDeal], { name: 'myDealsAsSeller' })
  myDealsAsSeller(@CurrentSeller() sellerId: string) {
    return this.deals.myDealsAsSeller(requireSeller(sellerId));
  }

  @Query(() => P2PReputation, { name: 'myP2PReputation' })
  myP2PReputation(@CurrentSeller() sellerId: string) {
    return this.deals.myReputation(requireSeller(sellerId));
  }

  /** Public: the deal rules, so a client can explain them before proposing. */
  @Query(() => P2PDealSettings, { name: 'p2pDealSettings' })
  p2pDealSettings() {
    return this.deals.dealSettings();
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

  /**
   * The eco-points this deal credited to the viewer, read from the ledger rows
   * the award writes (`deal:<id>`), so the app shows what was paid rather
   * than what the rules promise. Null before the deal completes and for anyone
   * outside it; 0 while the award has not landed.
   */
  @ResolveField(() => Int, { nullable: true })
  async myPoints(
    @Parent() deal: P2PDeal,
    @CurrentSeller() viewerId?: string,
  ): Promise<number | null> {
    if (
      deal.status !== P2PStatus.COMPLETED ||
      !viewerId ||
      (viewerId !== deal.buyerId && viewerId !== deal.sellerId)
    ) {
      return null;
    }
    const { _sum } = await this.prisma.transaction.aggregate({
      where: { sellerId: viewerId, notes: `deal:${deal.id}` },
      _sum: { pointsCollected: true },
    });
    return _sum.pointsCollected ?? 0;
  }
}
