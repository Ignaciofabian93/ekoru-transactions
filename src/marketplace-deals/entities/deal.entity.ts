import { ObjectType, Field, ID, Int, Directive } from '@nestjs/graphql';
import { P2PStatus, P2PDealType } from '../../graphql/enums/index.js';
import { Seller } from '../../common/entities/index.js';
import { ProductRef } from './product-ref.entity.js';

/**
 * A peer-to-peer marketplace deal — a cash sale or an exchange between two
 * sellers, meeting in person. EKORU never touches money; this record protects
 * the handover (two-sided confirmation + photo evidence, a deadline, strikes).
 *
 * `buyer`/`seller`/`product`/`requestedProduct`/`offeredProduct` are federation
 * refs resolved by the gateway against users / marketplace; the scalar ids are
 * also exposed for clients that only need the id.
 */
@ObjectType()
@Directive('@key(fields: "id")')
export class P2PDeal {
  // Int (not ID) so it matches every deal mutation's `id: Int` arg and the
  // client's numeric id — an ID here serializes as a string and fails Int
  // coercion on accept/confirm/decline/cancel/dispute.
  @Field(() => Int) id: number;
  @Field(() => P2PDealType) type: P2PDealType;
  @Field(() => P2PStatus) status: P2PStatus;

  @Field(() => String) buyerId: string;
  @Field(() => String) sellerId: string;

  @Field(() => Int, { nullable: true }) productId?: number | null;
  @Field(() => Int, { nullable: true }) requestedProductId?: number | null;
  @Field(() => Int, { nullable: true }) offeredProductId?: number | null;

  @Field(() => Int, {
    description: 'Cash to settle a substantial exchange price gap (0 = even).',
  })
  compensationAmount: number;

  @Field(() => String, {
    nullable: true,
    description: 'Who owes the cash compensation (owner of the cheaper item).',
  })
  compensationPayerId?: string | null;

  @Field(() => Date, { nullable: true }) agreedAt?: Date | null;
  @Field(() => Date, { nullable: true }) confirmationDeadline?: Date | null;
  @Field(() => Date, { nullable: true }) buyerConfirmedAt?: Date | null;
  @Field(() => Date, { nullable: true }) sellerConfirmedAt?: Date | null;
  @Field(() => String, { nullable: true }) buyerEvidenceUrl?: string | null;
  @Field(() => String, { nullable: true }) sellerEvidenceUrl?: string | null;
  @Field(() => Date, { nullable: true }) completedAt?: Date | null;
  @Field(() => Date, { nullable: true }) disputedAt?: Date | null;
  @Field(() => String, { nullable: true }) disputeReason?: string | null;
  @Field(() => String, { nullable: true }) cancelReason?: string | null;
  @Field(() => Date) createdAt: Date;
  @Field(() => Date) updatedAt: Date;

  // Federated refs (resolved in the resolver as { id }).
  @Field(() => Seller) buyer: Seller;
  @Field(() => Seller) seller: Seller;
  @Field(() => ProductRef, { nullable: true }) product?: ProductRef | null;
  @Field(() => ProductRef, { nullable: true })
  requestedProduct?: ProductRef | null;
  @Field(() => ProductRef, { nullable: true })
  offeredProduct?: ProductRef | null;
}

/** Per-seller P2P trust state (strikes, temporary block). */
@ObjectType()
export class P2PReputation {
  @Field(() => ID) id: number;
  @Field(() => String) sellerId: string;
  @Field(() => Int) strikes: number;
  @Field(() => Date, { nullable: true }) blockedUntil?: Date | null;
  @Field(() => Int) completedCount: number;
  @Field(() => Int) failedCount: number;
}
