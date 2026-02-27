import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service.js';
import { TransactionsResolver } from './transactions.resolver.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  providers: [TransactionsService, TransactionsResolver],
  exports: [TransactionsService],
})
export class TransactionsModule {}
