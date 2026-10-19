import { Module } from '@nestjs/common';
import { AdminConfigService } from './admin-config.service.js';
import { AdminConfigResolver } from './admin-config.resolver.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PaymentSecrets } from '../payments/payment-secrets.js';

@Module({
  imports: [PrismaModule],
  providers: [AdminConfigService, AdminConfigResolver, PaymentSecrets],
  exports: [AdminConfigService],
})
export class AdminConfigModule {}
