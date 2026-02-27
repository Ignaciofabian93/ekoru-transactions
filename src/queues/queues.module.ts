import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentProcessor } from './processors/payment.processor.js';
import { PAYMENT_QUEUE } from '../payments/payments.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';

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
    // Register the queue so the processor can attach to it
    BullModule.registerQueue({ name: PAYMENT_QUEUE }),
  ],
  providers: [PaymentProcessor],
})
export class QueuesModule {}
