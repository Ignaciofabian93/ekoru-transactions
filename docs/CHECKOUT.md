# Checkout subgraph changes (2026-05-26)

> **Runtime reference** for this layer (mutations, adapter contract, status
> mapping, adding a provider): [`PAYMENT_FLOW.md`](./PAYMENT_FLOW.md).

This subgraph now owns the full Order → Payment lifecycle that the web app
checkout flow drives. See the cross-repo reference doc at
[`ekoru-web-app/docs/CHECKOUT.md`](../../ekoru-web-app/docs/CHECKOUT.md) §2
for the end-to-end picture.

## What changed here

- **Schema** ([`prisma/schema.prisma`](../prisma/schema.prisma)): added
  `MERCADOPAGO` to `ChileanPaymentProvider`; new enums `OrderStatus`,
  `ShippingMethod`; new model `ShippingAddress`; extended `Order` with
  `buyerId`, `status`, totals, currency, shipping fields.
- **createOrder** ([`src/orders/orders.service.ts`](../src/orders/orders.service.ts))
  now computes totals from canonical marketplace prices and reads `buyerId`
  from the JWT — no client-supplied prices, no client-supplied sellerId.
- **createPayment** ([`src/payments/payments.service.ts`](../src/payments/payments.service.ts))
  calls the provider adapter synchronously and returns the redirect URL
  (Webpay form-POST union member, or external URL for Khipu/MercadoPago).
- **Provider adapters** ([`src/payments/providers/`](../src/payments/providers/))
  for Webpay Plus (Transbank), Khipu v3, and MercadoPago Checkout Pro.
- **Internal mutations** `processProviderReturn` / `processProviderWebhook`
  ([`src/payments/payments.resolver.ts`](../src/payments/payments.resolver.ts))
  for the gateway to call after handling provider callbacks. Both verify
  `INTERNAL_SERVICE_SECRET`.
- **MarketplaceClient** ([`src/common/clients/marketplace.client.ts`](../src/common/clients/marketplace.client.ts))
  for canonical price lookup. Requires a new `productsByIds` resolver in the
  marketplace subgraph (see web-app/CHECKOUT.md §4.4).
- **getOrdersByBuyer** query added — the buyer's order history (used by the
  web app's confirmation screen success state).

## Running this locally

Before `npm run start:dev` works against the new schema:

1. From the monorepo root:
   `npx prisma migrate dev --schema prisma/schema.prisma --name checkout_orders_addresses`
2. From this directory: `npx prisma generate`
3. `npm i transbank-sdk mercadopago` (Khipu uses native `fetch`).
4. Set env vars: `MARKETPLACE_URL`, `GATEWAY_BASE_URL`, `INTERNAL_SERVICE_SECRET`.

You'll see stale-type IDE errors in `orders.service.ts` and `payments.service.ts`
until step 2 runs — the Prisma client doesn't know about the new `status`,
`shippingAddress`, `MERCADOPAGO`, etc. until then.
