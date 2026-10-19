import { ObjectType, Field, Float } from '@nestjs/graphql';
import {
  ChileanPaymentProvider,
  PaymentEnvironment,
} from '../../graphql/enums/index.js';

/** A store's payout account as its business admin sees it (TRX-5). Never carries a token. */
@ObjectType({
  description:
    "A store's Mercado Pago connection: where its buyers' payments land.",
})
export class StorePaymentSetup {
  @Field(() => ChileanPaymentProvider)
  provider: ChileanPaymentProvider;

  @Field(() => Boolean, {
    description: 'Buyers can pay this store now.',
  })
  connected: boolean;

  @Field(() => Boolean, {
    description:
      'It was connected, but the authorization expired or was revoked: connect again.',
  })
  needsReconnect: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'The Mercado Pago user id of the connected account.',
  })
  accountId: string | null;

  @Field(() => PaymentEnvironment, { nullable: true })
  environment: PaymentEnvironment | null;

  @Field(() => Date, { nullable: true })
  connectedAt: Date | null;

  @Field(() => Date, { nullable: true })
  tokenExpiresAt: Date | null;

  @Field(() => Float, {
    description:
      "EKORU's commission on this store's sales, as a fraction (0.05 = 5%).",
  })
  commissionRate: number;
}
