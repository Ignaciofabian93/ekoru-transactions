import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalServerError, NotFoundError } from '../exceptions/index.js';

/**
 * Minimal slice of a store product the orders service needs to compute
 * canonical totals. The stores subgraph is the source of truth for
 * price/offer/stock/sellerId; the checkout never accepts these from the client.
 * Unlike marketplace products, store products can be on offer and carry stock.
 */
export interface StoreProductPrice {
  id: number;
  sellerId: string;
  price: number;
  hasOffer: boolean;
  offerPrice: number | null;
  isActive: boolean;
  stock: number;
}

/**
 * Client over the stores subgraph's GraphQL endpoint. Symmetric to
 * MarketplaceClient — thin, and aware of exactly the checkout fields.
 */
@Injectable()
export class StoresClient {
  private readonly logger = new Logger(StoresClient.name);

  constructor(private readonly config: ConfigService) {}

  async getPrices(storeProductIds: number[]): Promise<StoreProductPrice[]> {
    if (storeProductIds.length === 0) return [];

    const url = this.config.get<string>('subgraphs.stores');
    if (!url) {
      throw new InternalServerError('STORES_URL is not configured');
    }

    const query = /* GraphQL */ `
      query GetStoreProductPricesForCheckout($ids: [Int!]!) {
        storeProductsByIds(ids: $ids) {
          id
          sellerId
          price
          hasOffer
          offerPrice
          isActive
          stock
        }
      }
    `;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { ids: storeProductIds } }),
      });
    } catch (err) {
      this.logger.error('Stores subgraph unreachable', err);
      throw new InternalServerError(
        'No se pudo contactar al servicio de tiendas',
      );
    }

    if (!response.ok) {
      this.logger.error(
        `Stores returned ${response.status} for storeProductsByIds`,
      );
      throw new InternalServerError('Error al consultar precios en tiendas');
    }

    const body = (await response.json()) as {
      data?: { storeProductsByIds: StoreProductPrice[] };
      errors?: Array<{ message: string }>;
    };

    if (body.errors?.length) {
      this.logger.error('Stores GraphQL errors', body.errors);
      throw new InternalServerError(body.errors[0].message);
    }

    const products = body.data?.storeProductsByIds ?? [];

    const missing = storeProductIds.filter(
      (id) => !products.some((p) => p.id === id),
    );
    if (missing.length > 0) {
      throw new NotFoundError(
        `Productos de tienda no encontrados: ${missing.join(', ')}`,
      );
    }

    return products;
  }
}
