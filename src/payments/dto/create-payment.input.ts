import { InputType, Field, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsString, IsUrl } from 'class-validator';
import { ChileanPaymentProvider } from '../../graphql/enums/index.js';

/**
 * Minimal input the buyer can supply. Everything else (amount, currency,
 * payerId, receiverId, chileanConfigId) is resolved server-side from the
 * order + authenticated session.
 */
@InputType()
export class CreatePaymentInput {
  @Field(() => Int)
  @IsInt()
  orderId: number;

  @Field(() => ChileanPaymentProvider)
  @IsEnum(ChileanPaymentProvider)
  provider: ChileanPaymentProvider;

  /**
   * Absolute URL the provider should send the buyer back to. The gateway's
   * `/payments/return/:provider` endpoint typically lives here.
   */
  @Field(() => String)
  @IsString()
  @IsUrl({ require_tld: false, require_protocol: true })
  returnUrl: string;
}
