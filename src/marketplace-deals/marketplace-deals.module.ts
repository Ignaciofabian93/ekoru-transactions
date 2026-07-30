import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MarketplaceClient, UsersClient } from '../common/clients/index.js';
import { MarketplaceDealsService } from './marketplace-deals.service.js';
import { MarketplaceDealsResolver } from './marketplace-deals.resolver.js';

/**
 * Peer-to-peer marketplace deals (cash sales + exchanges) with the anti-scam
 * trust layer. Product validation/reservation goes through MarketplaceClient;
 * eco-points on completion through UsersClient. The deadline sweep worker
 * (QueuesModule) calls MarketplaceDealsService.sweepExpiredDeals().
 */
@Module({
  imports: [PrismaModule],
  providers: [
    MarketplaceDealsService,
    MarketplaceDealsResolver,
    MarketplaceClient,
    UsersClient,
  ],
  exports: [MarketplaceDealsService],
})
export class MarketplaceDealsModule {}
