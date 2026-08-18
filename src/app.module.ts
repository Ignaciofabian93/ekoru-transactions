import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { GqlThrottlerGuard } from './common/guards/gql-throttler.guard.js';
import { resolveIdentity } from './common/identity.js';
import { Request, Response } from 'express';
import { PrismaModule } from './prisma/prisma.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { TransactionsModule } from './transactions/transactions.module.js';
import { MarketplaceDealsModule } from './marketplace-deals/marketplace-deals.module.js';
import { AdminConfigModule } from './adminConfig/index.js';
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

    // ── Rate limiting ────────────────────────────────────────────────────────
    // 100 requests per minute per IP, matching the other subgraphs. This is a
    // ceiling on request volume, not on the cost of any one query — the depth
    // and complexity limits at the gateway cover that.
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),

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
          // Managed Redis (Azure Cache, Upstash, Redis Cloud) requires TLS.
          // Self-hosted Redis on the private ekoru-net doesn't — leave unset.
          ...(configService.get<string>('REDIS_TLS') === 'true'
            ? { tls: {} }
            : {}),
        },
        defaultJobOptions: {
          removeOnComplete: 100, // keep last 100 completed jobs
          removeOnFail: 500, // keep last 500 failed jobs for debugging
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
      playground: process.env.ENVIRONMENT !== 'production',
      context: ({ req, res }: { req: Request; res: Response }) => ({
        req,
        res,
        // Identity from the verified access token, not from the unsigned
        // `x-seller-id` / `x-admin-id` headers. See common/identity.ts.
        ...resolveIdentity(req.headers),
        // Set only by a direct service-to-service caller (the gateway's
        // PaymentsService). The gateway deliberately does NOT attach this to
        // federated requests — doing so made the internal
        // `processProviderReturn` / `processProviderWebhook` mutations callable
        // by any anonymous client through the public graph.
        internalSecret: req.headers['x-internal-secret'] as string | undefined,
      }),
      formatError: (error) => {
        if (process.env.ENVIRONMENT === 'production') {
          delete error.extensions?.exception;
        }
        return error;
      },
    }),

    // ── Database ─────────────────────────────────────────────────────────────
    PrismaModule,

    // ── Feature modules ───────────────────────────────────────────────────────
    PaymentsModule, // Payments – Chile-first (Khipu + Webpay)
    OrdersModule, // Orders + shipping tracking
    TransactionsModule, // Eco-transaction ledger + exchanges
    MarketplaceDealsModule, // P2P cash sales + exchanges (anti-scam trust layer)
    AdminConfigModule, // Platform-admin CRUD for config tables (TransactionFee…)

    // ── Queue workers ─────────────────────────────────────────────────────────
    QueuesModule, // BullMQ processors (payment, notifications)
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: GqlThrottlerGuard }],
})
export class AppModule {}
