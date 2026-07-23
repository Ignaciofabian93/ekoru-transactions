import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalServerError, NotFoundError } from '../exceptions/index.js';

/**
 * Minimal slice of a marketplace product the orders service needs to compute
 * canonical totals. The marketplace subgraph is the source of truth for price
 * + sellerId; the checkout never accepts these from the client.
 */
export interface MarketplaceProductPrice {
  id: number;
  sellerId: string;
  price: number;
  isActive: boolean;
}

/**
 * Client over the marketplace subgraph's GraphQL endpoint. Used to look up
 * product prices at order-creation time. Keep this thin — it should know
 * about exactly the fields the orders service needs, nothing more.
 */
@Injectable()
export class MarketplaceClient {
  private readonly logger = new Logger(MarketplaceClient.name);

  constructor(private readonly config: ConfigService) {}

  async getPrices(productIds: number[]): Promise<MarketplaceProductPrice[]> {
    if (productIds.length === 0) return [];

    const url = this.config.get<string>('subgraphs.marketplace');
    if (!url) {
      throw new InternalServerError('MARKETPLACE_URL is not configured');
    }

    // Marketplace products have no offer concept (that's StoreProduct only), so
    // we don't select hasOffer/offerPrice here — they aren't on the type.
    const query = /* GraphQL */ `
      query GetProductPricesForCheckout($ids: [Int!]!) {
        productsByIds(ids: $ids) {
          id
          sellerId
          price
          isActive
        }
      }
    `;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { ids: productIds } }),
      });
    } catch (err) {
      this.logger.error('Marketplace subgraph unreachable', err);
      throw new InternalServerError(
        'No se pudo contactar al servicio de marketplace',
      );
    }

    if (!response.ok) {
      this.logger.error(
        `Marketplace returned ${response.status} for productsByIds`,
      );
      throw new InternalServerError(
        'Error al consultar precios en el marketplace',
      );
    }

    const body = (await response.json()) as {
      data?: { productsByIds: MarketplaceProductPrice[] };
      errors?: Array<{ message: string }>;
    };

    if (body.errors?.length) {
      this.logger.error('Marketplace GraphQL errors', body.errors);
      throw new InternalServerError(body.errors[0].message);
    }

    const products = body.data?.productsByIds ?? [];

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
}
