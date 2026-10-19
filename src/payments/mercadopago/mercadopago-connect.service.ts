import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  BadRequestError,
  InternalServerError,
} from '../../common/exceptions/index.js';
import {
  ChileanPaymentProvider,
  PaymentEnvironment,
} from '../../graphql/enums/index.js';
import { CommissionService } from '../commission.service.js';
import { MercadoPagoApi, MercadoPagoApiError } from './mercadopago.api.js';
import {
  CONNECT_STATE_TTL_MS,
  pkceChallenge,
  pkceVerifier,
  readConnectState,
  signConnectState,
} from './mercadopago-oauth-state.js';

const PROVIDER = ChileanPaymentProvider.MERCADOPAGO;

/** What the panel shows a store about its Mercado Pago connection. */
export interface StorePaymentSetupView {
  provider: ChileanPaymentProvider;
  connected: boolean;
  needsReconnect: boolean;
  accountId: string | null;
  environment: PaymentEnvironment | null;
  connectedAt: Date | null;
  tokenExpiresAt: Date | null;
  commissionRate: number;
}

/**
 * Connects a store's own Mercado Pago account to EKORU's application (TRX-5,
 * D1). The store authorizes EKORU once on Mercado Pago; from then on its
 * buyers pay into its account and EKORU's commission is split off at source.
 * EKORU never holds sale money.
 *
 * The connection is the store's `ChileanPaymentConfig` row for MERCADOPAGO:
 * the access token in `secretKey`, the account id in `merchantId`, plus the
 * refresh token and its expiry. Tokens are never returned by any query.
 */
@Injectable()
export class MercadoPagoConnectService {
  private readonly logger = new Logger(MercadoPagoConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly api: MercadoPagoApi,
    private readonly commission: CommissionService,
  ) {}

  async status(sellerId: string): Promise<StorePaymentSetupView> {
    const [row, quote] = await Promise.all([
      this.prisma.chileanPaymentConfig.findUnique({
        where: { sellerId_provider: { sellerId, provider: PROVIDER } },
        select: {
          merchantId: true,
          secretKey: true,
          refreshToken: true,
          tokenExpiresAt: true,
          environment: true,
          isActive: true,
          updatedAt: true,
        },
      }),
      this.commission.quote({ sellerId, amount: 100 }),
    ]);
    const unexpired =
      !row?.tokenExpiresAt || row.tokenExpiresAt.getTime() > Date.now();
    const connected = !!row?.isActive && !!row.secretKey && unexpired;
    return {
      provider: PROVIDER,
      connected,
      // Connected once, then lost: the token expired, Mercado Pago revoked it,
      // or the store unlinked EKORU from its Mercado Pago account.
      needsReconnect: !!row && !connected && !!row.refreshToken,
      accountId: row?.merchantId ?? null,
      environment: (row?.environment as PaymentEnvironment | undefined) ?? null,
      connectedAt: connected ? row.updatedAt : null,
      tokenExpiresAt: row?.tokenExpiresAt ?? null,
      commissionRate: quote.rate,
    };
  }

  /** The Mercado Pago authorization page this store's admin is sent to. */
  authorizationUrl({
    sellerId,
    adminId,
  }: {
    sellerId: string;
    adminId: string;
  }): string {
    const { clientId, redirectUri } = this.appSettings();
    const state = signConnectState(
      { sellerId, adminId, expiresAt: Date.now() + CONNECT_STATE_TTL_MS },
      this.stateKey(),
    );
    const url = new URL(
      '/authorization',
      this.config.get<string>(
        'mercadoPago.authBaseUrl',
        'https://auth.mercadopago.com',
      ),
    );
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('platform_id', 'mp');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    if (this.usePkce()) {
      url.searchParams.set(
        'code_challenge',
        pkceChallenge(pkceVerifier(state, this.stateKey())),
      );
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  /**
   * Finishes the connection with the code Mercado Pago sent back. The state
   * must be one this service signed, still fresh, for this same store and
   * started by this same admin, so a code cannot be grafted onto another
   * store's session.
   */
  async complete({
    sellerId,
    adminId,
    code,
    state,
  }: {
    sellerId: string;
    adminId: string;
    code: string;
    state: string;
  }): Promise<StorePaymentSetupView> {
    const content = readConnectState(state, this.stateKey());
    if (!content) {
      throw new BadRequestError(
        'El enlace de Mercado Pago expiró o no es válido. Vuelve a conectar.',
      );
    }
    if (content.sellerId !== sellerId || content.adminId !== adminId) {
      throw new BadRequestError(
        'Esta conexión la inició otra cuenta. Vuelve a conectar desde aquí.',
      );
    }

    const { redirectUri } = this.appSettings();
    let token;
    try {
      token = await this.api.exchangeCode({
        code,
        redirectUri,
        codeVerifier: this.usePkce()
          ? pkceVerifier(state, this.stateKey())
          : undefined,
        testToken: this.useTestToken(),
      });
    } catch (error) {
      this.logger.warn(
        `Mercado Pago code exchange failed for seller ${sellerId}: ${String(error)}`,
      );
      throw new BadRequestError(
        'Mercado Pago no aceptó la autorización. Vuelve a conectar.',
      );
    }

    const data = {
      merchantId: String(token.user_id),
      secretKey: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      publicKey: token.public_key,
      environment: token.live_mode
        ? PaymentEnvironment.PRODUCTION
        : PaymentEnvironment.SANDBOX,
      isActive: true,
    };
    await this.prisma.chileanPaymentConfig.upsert({
      where: { sellerId_provider: { sellerId, provider: PROVIDER } },
      create: { sellerId, provider: PROVIDER, ...data },
      update: data,
    });
    this.logger.log(
      `Seller ${sellerId} connected Mercado Pago account ${token.user_id}`,
    );
    return this.status(sellerId);
  }

  /**
   * Stops new charges to this store. The token is kept, not wiped: refunds of
   * sales already made are keyed on it. To revoke EKORU's access entirely the
   * store unlinks the application in its own Mercado Pago account.
   */
  async disconnect(sellerId: string): Promise<StorePaymentSetupView> {
    await this.prisma.chileanPaymentConfig.updateMany({
      where: { sellerId, provider: PROVIDER },
      data: { isActive: false, refreshToken: null },
    });
    return this.status(sellerId);
  }

  /** Mercado Pago told us a store unlinked EKORU (webhook topic mp-connect). */
  async deauthorize(accountId: string): Promise<number> {
    const { count } = await this.prisma.chileanPaymentConfig.updateMany({
      where: { provider: PROVIDER, merchantId: accountId },
      data: { isActive: false },
    });
    if (count) {
      this.logger.warn(
        `Mercado Pago account ${accountId} unlinked EKORU; ${count} store connection(s) paused`,
      );
    }
    return count;
  }

  /**
   * Job: access tokens last 180 days. Renews the ones expiring soon; a refused
   * grant pauses the connection so the store is asked to reconnect, any other
   * error is retried on the next run.
   */
  async refreshExpiring(): Promise<{ refreshed: number; paused: number }> {
    const days = this.config.get<number>('mercadoPago.refreshWithinDays', 30);
    const rows = await this.prisma.chileanPaymentConfig.findMany({
      where: {
        provider: PROVIDER,
        isActive: true,
        refreshToken: { not: null },
        tokenExpiresAt: { lt: new Date(Date.now() + days * 86_400_000) },
      },
      select: { id: true, sellerId: true, refreshToken: true },
      take: 200,
    });
    let refreshed = 0;
    let paused = 0;
    for (const row of rows) {
      try {
        const token = await this.api.refreshToken(row.refreshToken!);
        await this.prisma.chileanPaymentConfig.update({
          where: { id: row.id },
          data: {
            secretKey: token.access_token,
            refreshToken: token.refresh_token,
            tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
            publicKey: token.public_key,
          },
        });
        refreshed++;
      } catch (error) {
        if (error instanceof MercadoPagoApiError && error.isInvalidGrant) {
          await this.prisma.chileanPaymentConfig.update({
            where: { id: row.id },
            data: { isActive: false },
          });
          paused++;
          this.logger.warn(
            `Mercado Pago refused to renew seller ${row.sellerId}'s token; connection paused`,
          );
        } else {
          this.logger.error(
            `Mercado Pago token renewal failed for seller ${row.sellerId}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    }
    if (refreshed || paused) {
      this.logger.log(
        `Mercado Pago tokens: ${refreshed} renewed, ${paused} paused`,
      );
    }
    return { refreshed, paused };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private appSettings(): { clientId: string; redirectUri: string } {
    const clientId = this.config.get<string>('mercadoPago.clientId');
    const redirectUri = this.config.get<string>('mercadoPago.redirectUri');
    if (!clientId || !redirectUri || !this.secret()) {
      throw new InternalServerError(
        'Mercado Pago no está configurado (MERCADOPAGO_CLIENT_ID, MERCADOPAGO_CLIENT_SECRET, MERCADOPAGO_REDIRECT_URI)',
      );
    }
    return { clientId, redirectUri };
  }

  private secret(): string | undefined {
    return this.config.get<string>('mercadoPago.clientSecret');
  }

  /** A key of its own for the state, derived from the application secret. */
  private stateKey(): string {
    const secret = this.secret();
    if (!secret) {
      throw new InternalServerError('MERCADOPAGO_CLIENT_SECRET no configurado');
    }
    return createHmac('sha256', secret)
      .update('ekoru:mp-connect')
      .digest('hex');
  }

  private usePkce(): boolean {
    return this.config.get<boolean>('mercadoPago.usePkce', true);
  }

  private useTestToken(): boolean {
    return this.config.get<boolean>(
      'mercadoPago.testToken',
      this.config.get<string>('mercadoPago.environment') !== 'PRODUCTION',
    );
  }
}
