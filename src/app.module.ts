import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { BullModule } from '@nestjs/bullmq';
import { Request, Response } from 'express';
import { PrismaModule } from './prisma/prisma.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { TransactionsModule } from './transactions/transactions.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { GraphQLJSON } from './graphql/scalars/index.js';
import configuration from './config/configuration.js';
import { HealthController } from './health/health.controller.js';

// Register enums
import './graphql/enums/index.js';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

@Module({
  imports: [
    // ── Metrics ───────────────────────────────────────────────────────────────
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),

    // ── Configuration ────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // ── BullMQ / Redis ────────────────────────────────────────────────────────
    // Configured once here; all queues & processors share this connection.
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
        },
        defaultJobOptions: {
          removeOnComplete: 100, // keep last 100 completed jobs
          removeOnFail: 500,     // keep last 500 failed jobs for debugging
        },
      }),
    }),

    // ── GraphQL Federation ───────────────────────────────────────────────────
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: {
        federation: 2,
      },
      sortSchema: true,
      resolvers: { JSON: GraphQLJSON },
      playground: process.env.NODE_ENV !== 'production',
      context: ({ req, res }: { req: Request; res: Response }) => ({
        req,
        res,
        sellerId: req.headers['x-seller-id'] as string,
        token: req.headers.authorization?.replace('Bearer ', '') as string,
      }),
      formatError: (error) => {
        if (process.env.NODE_ENV === 'production') {
          delete error.extensions?.exception;
        }
        return error;
      },
    }),

    // ── Database ─────────────────────────────────────────────────────────────
    PrismaModule,

    // ── Feature modules ───────────────────────────────────────────────────────
    PaymentsModule,      // Payments – Chile-first (Khipu + Webpay)
    OrdersModule,        // Orders + shipping tracking
    TransactionsModule,  // Eco-transaction ledger + exchanges

    // ── Queue workers ─────────────────────────────────────────────────────────
    QueuesModule,        // BullMQ processors (payment, notifications)
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
