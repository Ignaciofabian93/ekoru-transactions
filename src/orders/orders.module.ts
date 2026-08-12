import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { OrdersResolver, OrderItemResolver } from './orders.resolver.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import {
  MarketplaceClient,
  StoresClient,
  UsersClient,
} from '../common/clients/index.js';

@Module({
  imports: [PrismaModule],
  providers: [
    OrdersService,
    OrdersResolver,
    OrderItemResolver,
    MarketplaceClient,
    StoresClient,
    // Order lifecycle emails — users owns the templates and the preference gate.
    UsersClient,
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
