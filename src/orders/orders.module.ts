import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { OrdersResolver } from './orders.resolver.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MarketplaceClient } from '../common/clients/index.js';

@Module({
  imports: [PrismaModule],
  providers: [OrdersService, OrdersResolver, MarketplaceClient],
  exports: [OrdersService],
})
export class OrdersModule {}
