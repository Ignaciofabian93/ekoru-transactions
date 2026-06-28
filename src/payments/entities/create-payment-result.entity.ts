import { ObjectType, Field, ID } from '@nestjs/graphql';
import {
  ChileanPaymentProvider,
  PaymentStatus,
} from '../../graphql/enums/index.js';
import { Payment } from './payment.entity.js';
import { PaymentRedirect } from './payment-redirect.entity.js';

/**
 * Returned by the `createPayment` mutation. The redirect field is the union
 * the frontend uses to decide whether to form-POST (Webpay) or navigate (the
 * external-redirect providers).
 */
@ObjectType()
export class CreatePaymentResult {
  @Field(() => ID)
  paymentId: string;

  @Field(() => ChileanPaymentProvider)
  provider: ChileanPaymentProvider;

  @Field(() => PaymentStatus)
  status: PaymentStatus;

  @Field(() => PaymentRedirect)
  redirect: typeof PaymentRedirect;

  @Field(() => Payment)
  payment: Payment;
}
