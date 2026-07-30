import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalServerError, NotFoundError } from '../exceptions/index.js';

/**
 * Minimal slice of a marketplace product callers need. The marketplace subgraph
 * is the source of truth for price + sellerId + availability; the checkout /
 * deal flows never accept these from the client.
 */
export interface MarketplaceProductPrice {
  id: number;
  sellerId: string;
  price: number;
  isActive: boolean;
  isExchangeable: boolean;
  /** Set while an accepted P2P deal holds the item; in the future = reserved. */
  reservedUntil: string | null;
}

/**
 * Client over the marketplace subgraph's GraphQL endpoint. Reads product
 * price/availability, and (for P2P deals) drives reservation/sold state via the
 * internal, secret-guarded `setProductAvailability` mutation.
 */
@Injectable()
export class MarketplaceClient {
  private readonly logger = new Logger(MarketplaceClient.name);

  constructor(private readonly config: ConfigService) {}

  async getPrices(productIds: number[]): Promise<MarketplaceProductPrice[]> {
    if (productIds.length === 0) return [];

    // Marketplace products have no offer concept (that's StoreProduct only).
    const query = /* GraphQL */ `
      query GetProductsForCheckout($ids: [Int!]!) {
        productsByIds(ids: $ids) {
          id
          sellerId
          price
          isActive
          isExchangeable
          reservedUntil
        }
      }
    `;
    const data = await this.call<{ productsByIds: MarketplaceProductPrice[] }>(
      query,
      { ids: productIds },
    );
    const products = data.productsByIds ?? [];

    const missing = productIds.filter(
      (id) => !products.some((p) => p.id === id),
    );
    if (missing.length > 0) {
      throw new NotFoundError(
        `Productos no encontrados: ${missing.join(', ')}`,
      );
    }
    return products;
  }

  /** True if the item is currently held by another deal. */
  isReserved(p: Pick<MarketplaceProductPrice, 'reservedUntil'>): boolean {
    return (
      !!p.reservedUntil && new Date(p.reservedUntil).getTime() > Date.now()
    );
  }

  /** Reserve items until `until` (accepted deal). Best-effort; logs on failure. */
  async reserveProducts(productIds: number[], until: Date): Promise<void> {
    await this.setAvailability(productIds, {
      reservedUntil: until.toISOString(),
    });
  }

  /** Release a reservation (deal expired/cancelled/declined). */
  async releaseProducts(productIds: number[]): Promise<void> {
    await this.setAvailability(productIds, { reservedUntil: null });
  }

  /** Mark items sold + remove from sale (deal completed). */
  async markProductsSold(productIds: number[]): Promise<void> {
    await this.setAvailability(productIds, { sold: true });
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async setAvailability(
    productIds: number[],
    change: { reservedUntil?: string | null; sold?: boolean },
  ): Promise<void> {
    if (productIds.length === 0) return;
    const secret = this.config.get<string>('internalSecret');
    if (!secret) {
      throw new InternalServerError('INTERNAL_SERVICE_SECRET no configurado');
    }
    const mutation = /* GraphQL */ `
      mutation SetProductAvailability(
        $ids: [Int!]!
        $reservedUntil: DateTime
        $sold: Boolean
        $secret: String!
      ) {
        setProductAvailability(
          ids: $ids
          reservedUntil: $reservedUntil
          sold: $sold
          internalSecret: $secret
        )
      }
    `;
    // Best-effort: a reservation glitch must not corrupt the deal record.
    try {
      await this.call(
        mutation,
        {
          ids: productIds,
          reservedUntil: change.reservedUntil ?? null,
          sold: change.sold ?? null,
          secret,
        },
        secret,
      );
    } catch (err) {
      this.logger.error(
        `setProductAvailability failed for ${productIds.join(',')}`,
        err,
      );
    }
  }

  private async call<T>(
    query: string,
    variables: Record<string, unknown>,
    internalSecret?: string,
  ): Promise<T> {
    const url = this.config.get<string>('subgraphs.marketplace');
    if (!url)
      throw new InternalServerError('MARKETPLACE_URL is not configured');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalSecret ? { 'x-internal-secret': internalSecret } : {}),
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      this.logger.error('Marketplace subgraph unreachable', err);
      throw new InternalServerError(
        'No se pudo contactar al servicio de marketplace',
      );
    }
    if (!response.ok) {
      this.logger.error(`Marketplace returned ${response.status}`);
      throw new InternalServerError('Error al consultar el marketplace');
    }
    const body = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
      this.logger.error('Marketplace GraphQL errors', body.errors);
      throw new InternalServerError(body.errors[0].message);
    }
    if (!body.data) throw new InternalServerError('Marketplace devolvió vacío');
    return body.data;
  }
}
