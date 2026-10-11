import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AdminOperationsResolver } from './admin-operations.resolver.js';

/** Operator lists for the admin panel: orders, payments, refunds, deals (TRX-11). */
@Module({
  imports: [OrdersModule, PaymentsModule],
  providers: [AdminOperationsResolver],
})
export class AdminOperationsModule {}
