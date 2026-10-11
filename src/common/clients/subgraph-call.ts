import { Logger } from '@nestjs/common';
import { InternalServerError } from '../exceptions/index.js';

/**
 * A GraphQL error returned by a sibling subgraph, with its code kept, so the
 * caller can tell "refused" (BAD_REQUEST, NOT_FOUND) from "broken" and act on
 * it: a quotation already paid with another payment is refunded, not retried.
 */
export class SubgraphError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'SubgraphError';
  }
}

/**
 * One direct service-to-service GraphQL call (not through the gateway). The
 * internal secret, when given, travels only as the `x-internal-secret`
 * header, which the gateway never forwards from browsers.
 */
export async function callSubgraph<T>({
  url,
  name,
  query,
  variables,
  internalSecret,
  logger,
}: {
  url: string | undefined;
  /** For messages: "stores", "services". */
  name: string;
  query: string;
  variables: Record<string, unknown>;
  internalSecret?: string;
  logger: Logger;
}): Promise<T> {
  if (!url) throw new InternalServerError(`${name} URL is not configured`);

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
    logger.error(`${name} subgraph unreachable`, err);
    throw new InternalServerError(`No se pudo contactar al servicio ${name}`);
  }

  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (body.errors?.length) {
    const first = body.errors[0];
    throw new SubgraphError(first.message, first.extensions?.code);
  }
  if (!response.ok || !body.data) {
    logger.error(`${name} returned ${response.status}`);
    throw new InternalServerError(`Error al consultar el servicio ${name}`);
  }
  return body.data;
}
