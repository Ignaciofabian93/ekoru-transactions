import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsService, PAYMENT_QUEUE } from './payments.service.js';
import { PaymentsResolver } from './payments.resolver.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import {
  ServicesClient,
  StoresClient,
  UsersClient,
} from '../common/clients/index.js';
import { SettlementService } from './settlement.service.js';
import { CommissionService } from './commission.service.js';
import {
  ProviderRegistry,
  WebpayAdapter,
  KhipuAdapter,
  MercadoPagoAdapter,
} from './providers/index.js';
import { MercadoPagoApi } from './mercadopago/mercadopago.api.js';
import { MercadoPagoConnectService } from './mercadopago/mercadopago-connect.service.js';
import { MercadoPagoConnectResolver } from './mercadopago/mercadopago-connect.resolver.js';

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
    MercadoPagoApi, // REST client, each call with the store's own token
    MercadoPagoConnectService, // stores connect their account with OAuth (TRX-5)
    MercadoPagoConnectResolver,
    CommissionService, // EKORU's commission per seller type (TRX-10)
    UsersClient, // pricing + activation for subscription (platform) payments
    SettlementService, // completion, refunds, stock, expiry
    StoresClient, // stock after a paid or refunded order (TRX-3)
    ServicesClient, // quotation charge and mark-paid (TRX-6)
  ],
  exports: [PaymentsService, SettlementService, MercadoPagoConnectService],
})
export class PaymentsModule {}
