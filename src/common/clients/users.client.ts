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
 * Notification types this service emits. A subset of the users subgraph's
 * `NotificationType` — kept as a string union rather than imported so the two
 * services stay independently deployable.
 */
export type NotificationType =
  | 'SALE_PROPOSAL'
  | 'EXCHANGE_PROPOSAL'
  | 'EXCHANGE_ACCEPTED'
  | 'EXCHANGE_DECLINED'
  | 'EXCHANGE_COMPLETED'
  | 'ORDER_RECEIVED'
  | 'ORDER_CONFIRMED'
  | 'ORDER_SHIPPED'
  | 'ORDER_DELIVERED'
  | 'ORDER_CANCELLED'
  | 'PAYMENT_REFUNDED';

/** Coarse lifecycle stage shown to the buyer/seller. */
export type TransactionEmailStage =
  | 'STARTED'
  | 'IN_PROCESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface TransactionNotification {
  type: NotificationType;
  stage: TransactionEmailStage;
  role: 'BUYER' | 'SELLER';
  /** Reference shown to the user, e.g. "#1042" or "Trato #57". */
  reference: string;
  summary: string;
  amount?: number | null;
  currency?: string | null;
  counterpartName?: string | null;
  note?: string | null;
  detailUrl?: string | null;
  /** Order/deal id, for deep-linking from the in-app feed. */
  relatedId?: string | null;
}

export interface DealOfferNotification {
  dealKind: 'SALE' | 'EXCHANGE';
  /**
   * The seller who made the offer. users resolves this to a display name, so
   * this service never fetches a profile just to address a notification.
   */
  actorSellerId: string;
  requestedProductTitle: string;
  requestedProductImage?: string | null;
  requestedProductPrice?: number | null;
  offeredProductTitle?: string | null;
  offeredProductImage?: string | null;
  offeredProductPrice?: number | null;
  compensationAmount?: number | null;
  compensationPaidByRecipient?: boolean;
  currency?: string | null;
  dealUrl?: string | null;
  relatedId?: string | null;
}

/**
 * Client over the users subgraph. Two families of calls:
 *
 *   Subscription payments
 *     - getMembershipCharge: price a plan before we create the platform Payment.
 *     - activateMembership: after the Payment completes, tell users to create
 *       the subscription.
 *
 *   Notifications
 *     - notifyTransaction / notifyDealOffer: report that something happened.
 *       Both funnel into the single `emitNotification` seam; users decides
 *       which channels fire (in-app always, email and push per
 *       `SellerPreferences`) and owns all the copy. This service never decides
 *       whether a notification is wanted — it only reports the event. Both are
 *       best-effort and never throw.
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

  // ─── notifications ────────────────────────────────────────────────────────

  /**
   * Tells `sellerId` how their order or deal is progressing. Returns whether
   * the notification was recorded — `false` when users is unreachable or the
   * account is inactive. A recorded notification always reaches the in-app
   * feed; email and push depend on the recipient's preferences.
   */
  async notifyTransaction(
    sellerId: string,
    { type, relatedId, detailUrl, ...data }: TransactionNotification,
  ): Promise<boolean> {
    return this.emit({
      sellerId,
      type,
      relatedId,
      actionUrl: detailUrl,
      data: { ...data, detailUrl },
    });
  }

  /**
   * Tells the owner of a product that another seller proposed a sale or an
   * exchange. `sellerId` is the owner being notified, not the offerer.
   */
  async notifyDealOffer(
    sellerId: string,
    { dealKind, relatedId, dealUrl, ...data }: DealOfferNotification,
  ): Promise<boolean> {
    return this.emit({
      sellerId,
      type: dealKind === 'EXCHANGE' ? 'EXCHANGE_PROPOSAL' : 'SALE_PROPOSAL',
      relatedId,
      actionUrl: dealUrl,
      data: { ...data, dealKind, dealUrl },
    });
  }

  /**
   * The one seam every notification goes through. A notification is a side
   * effect of the caller's real work, so a failure here is logged and
   * swallowed rather than rolling back a completed deal or order.
   */
  private async emit(input: {
    sellerId: string;
    type: NotificationType;
    relatedId?: string | null;
    actionUrl?: string | null;
    data: Record<string, unknown>;
  }): Promise<boolean> {
    const mutation = /* GraphQL */ `
      mutation EmitNotification(
        $input: EmitNotificationInput!
        $secret: String!
      ) {
        emitNotification(input: $input, internalSecret: $secret)
      }
    `;
    try {
      const secret = this.internalSecret();
      const data = await this.call<{ emitNotification: number | null }>(
        mutation,
        { input, secret },
        secret,
      );
      return data.emitNotification != null;
    } catch (err) {
      this.logger.error(`emitNotification(${input.type}) failed`, err);
      return false;
    }
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
