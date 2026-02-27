import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { OrdersResolver } from './orders.resolver.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  providers: [OrdersService, OrdersResolver],
  exports: [OrdersService],
})
export class OrdersModule {}
