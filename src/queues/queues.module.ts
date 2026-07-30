import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentProcessor } from './processors/payment.processor.js';
import {
  P2pDealsProcessor,
  P2P_DEALS_QUEUE,
} from './processors/p2p-deals.processor.js';
import { PAYMENT_QUEUE } from '../payments/payments.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MarketplaceDealsModule } from '../marketplace-deals/marketplace-deals.module.js';

/**
 * QueuesModule
 * ─────────────
 * Registers BullMQ workers (processors). The BullModule.registerQueue() calls
 * in feature modules (PaymentsModule) register the *producer* side.
 * This module registers the *consumer* (worker) side.
 *
 * Redis is configured once in AppModule via BullModule.forRoot() and shared
 * across all queues and processors automatically.
 */
@Module({
  imports: [
    PrismaModule,
    MarketplaceDealsModule, // P2pDealsProcessor → MarketplaceDealsService.sweep
    // Register the queues so the processors can attach to them
    BullModule.registerQueue({ name: PAYMENT_QUEUE }),
    BullModule.registerQueue({ name: P2P_DEALS_QUEUE }),
  ],
  providers: [PaymentProcessor, P2pDealsProcessor],
})
export class QueuesModule {}
