import { ObjectType, Field, ID } from '@nestjs/graphql';
import { PaymentStatus } from '../../graphql/enums/index.js';

/**
 * Returned by the internal `processProviderReturn` mutation (gateway → this
 * subgraph). It carries BOTH the canonical PaymentStatus and the internal
 * Payment id.
 *
 * The id matters: the gateway redirects the buyer to
 * `/{lang}/cart/confirmation?paymentId=…`, and the confirmation screen polls
 * `payment(id:)` with it. The gateway can't reliably re-derive that id from the
 * provider's return payload — a normal Webpay success carries only `token_ws`,
 * not the buy order — so the subgraph, which already looked the Payment up to
 * commit it, hands the id back here.
 */
@ObjectType()
export class ProviderReturnResult {
  @Field(() => ID, {
    description: 'Internal Payment id, for the confirmation-page redirect.',
  })
  paymentId: string;

  @Field(() => PaymentStatus, {
    description: 'Canonical payment status after the provider confirm step.',
  })
  status: PaymentStatus;
}
