import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalServerError } from '../exceptions/index.js';

/** Server-side price for one membership term, resolved by the users subgraph. */
export interface MembershipCharge {
  price: number;
  currency: string;
  durationMonths: number;
}

/**
 * Client over the users subgraph, for the subscription-payment flow. Two calls:
 *   - getMembershipCharge: price a plan before we create the platform Payment.
 *   - activateMembership: after the Payment completes, tell users to create the
 *     subscription (guarded by the shared internal secret).
 *
 * Called directly service-to-service (not through the gateway), so the internal
 * secret is sent both as the `x-internal-secret` header and the mutation arg —
 * the users resolver accepts either.
 */
@Injectable()
export class UsersClient {
  private readonly logger = new Logger(UsersClient.name);

  constructor(private readonly config: ConfigService) {}

  async getMembershipCharge(
    membershipId: number,
    sellerId: string,
  ): Promise<MembershipCharge> {
    const query = /* GraphQL */ `
      query GetMembershipCharge($membershipId: Int!, $sellerId: ID!) {
        getMembershipCharge(membershipId: $membershipId, sellerId: $sellerId) {
          price
          currency
          durationMonths
        }
      }
    `;
    const data = await this.call<{ getMembershipCharge: MembershipCharge }>(
      query,
      { membershipId, sellerId },
    );
    return data.getMembershipCharge;
  }

  async activateMembership(args: {
    sellerId: string;
    membershipId: number;
    paymentId: number;
  }): Promise<number> {
    const secret = this.internalSecret();
    const mutation = /* GraphQL */ `
      mutation ActivateMembership(
        $sellerId: ID!
        $membershipId: Int!
        $paymentId: Int!
        $secret: String!
      ) {
        activateMembershipSubscription(
          sellerId: $sellerId
          membershipId: $membershipId
          paymentId: $paymentId
          internalSecret: $secret
        )
      }
    `;
    const data = await this.call<{ activateMembershipSubscription: number }>(
      mutation,
      { ...args, secret },
      secret,
    );
    return data.activateMembershipSubscription;
  }

  /** Credits eco-points to a seller (best-effort; guarded by internal secret). */
  async awardPoints(sellerId: string, points: number): Promise<void> {
    const secret = this.internalSecret();
    const mutation = /* GraphQL */ `
      mutation AwardPoints($sellerId: ID!, $points: Int!, $secret: String!) {
        awardPoints(
          sellerId: $sellerId
          points: $points
          internalSecret: $secret
        )
      }
    `;
    await this.call(mutation, { sellerId, points, secret }, secret);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private internalSecret(): string {
    const secret = this.config.get<string>('internalSecret');
    if (!secret) {
      throw new InternalServerError('INTERNAL_SERVICE_SECRET no configurado');
    }
    return secret;
  }

  private async call<T>(
    query: string,
    variables: Record<string, unknown>,
    internalSecret?: string,
  ): Promise<T> {
    const url = this.config.get<string>('subgraphs.users');
    if (!url) throw new InternalServerError('USERS_URL is not configured');

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
      this.logger.error('Users subgraph unreachable', err);
      throw new InternalServerError(
        'No se pudo contactar al servicio de usuarios',
      );
    }

    if (!response.ok) {
      this.logger.error(`Users returned ${response.status}`);
      throw new InternalServerError(
        'Error al consultar el servicio de usuarios',
      );
    }

    const body = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
      this.logger.error('Users GraphQL errors', body.errors);
      throw new InternalServerError(body.errors[0].message);
    }
    if (!body.data)
      throw new InternalServerError('Users devolvió una respuesta vacía');
    return body.data;
  }
}
