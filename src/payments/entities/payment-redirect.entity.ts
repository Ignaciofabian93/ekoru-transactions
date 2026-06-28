import { ObjectType, Field, createUnionType } from '@nestjs/graphql';

/**
 * Shape returned by `createPayment` so the frontend knows how to hand off to
 * the provider. Webpay (Transbank) requires a hidden form-POST with `token_ws`,
 * so it returns both a URL *and* a token. Khipu and MercadoPago return a
 * plain URL the browser can navigate to with GET.
 */

@ObjectType()
export class WebpayRedirect {
  /** Discriminator: always 'WEBPAY_FORM' for this variant. */
  @Field(() => String)
  kind: 'WEBPAY_FORM';

  /** The URL the client must POST `token_ws` to (Transbank's `webpay_plus_form.cgi`). */
  @Field(() => String)
  url: string;

  /** The Transbank transaction token; submitted as a hidden `token_ws` form field. */
  @Field(() => String)
  token: string;
}

@ObjectType()
export class ExternalRedirect {
  /** Discriminator: always 'EXTERNAL' for this variant. */
  @Field(() => String)
  kind: 'EXTERNAL';

  /** The hosted-checkout URL the buyer should be navigated to. */
  @Field(() => String)
  url: string;
}

export const PaymentRedirect = createUnionType({
  name: 'PaymentRedirect',
  types: () => [WebpayRedirect, ExternalRedirect] as const,
  resolveType: (value: WebpayRedirect | ExternalRedirect) =>
    value.kind === 'WEBPAY_FORM' ? WebpayRedirect : ExternalRedirect,
});

export type PaymentRedirectUnion = WebpayRedirect | ExternalRedirect;
