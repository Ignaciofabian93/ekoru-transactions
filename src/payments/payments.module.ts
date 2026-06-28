import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsService, PAYMENT_QUEUE } from './payments.service.js';
import { PaymentsResolver } from './payments.resolver.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import {
  ProviderRegistry,
  WebpayAdapter,
  KhipuAdapter,
  MercadoPagoAdapter,
} from './providers/index.js';

@Module({
  imports: [
    PrismaModule,
    OrdersModule, // PaymentsService.markPaid / markCanceled → OrdersService
    BullModule.registerQueue({ name: PAYMENT_QUEUE }),
  ],
  providers: [
    PaymentsService,
    PaymentsResolver,
    ProviderRegistry,
    WebpayAdapter,
    KhipuAdapter,
    MercadoPagoAdapter,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
