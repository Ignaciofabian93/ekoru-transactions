import { Module } from '@nestjs/common';
import { AdminConfigService } from './admin-config.service.js';
import { AdminConfigResolver } from './admin-config.resolver.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  providers: [AdminConfigService, AdminConfigResolver],
  exports: [AdminConfigService],
})
export class AdminConfigModule {}
