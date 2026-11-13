import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor() {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      // Bounded waits (INF-24). The defaults wait for ever: for a free
      // connection when all 10 are busy, and for a statement that never ends.
      connectionTimeoutMillis: 15_000,
      statement_timeout: 30_000,
    });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /** Shutdown's last phase, after requests and jobs in progress have finished. */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
