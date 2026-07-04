# Transbank Webpay Plus — Integration Guide

How the `ekoru-transactions` subgraph charges Chilean credit/debit cards through
**Webpay Plus** using the official [`transbank-sdk`](https://www.npmjs.com/package/transbank-sdk)
(v6.x). Webpay is one of three providers behind the `ChileanPaymentProvider`
enum (`KHIPU`, `WEBPAY`, `MERCADOPAGO`); this doc only covers `WEBPAY`.

Reference: <https://www.transbankdevelopers.cl/documentacion/como_empezar?l=javascript>

---

## 1. Where the code lives

| Concern | File |
|---|---|
| SDK calls (create / commit) | [`src/payments/providers/webpay.adapter.ts`](../src/payments/providers/webpay.adapter.ts) |
| Adapter contract | [`src/payments/providers/provider-adapter.ts`](../src/payments/providers/provider-adapter.ts) |
| Provider dispatch | [`src/payments/providers/index.ts`](../src/payments/providers/index.ts) |
| Create payment + return handling | [`src/payments/payments.service.ts`](../src/payments/payments.service.ts) |
| GraphQL mutations | [`src/payments/payments.resolver.ts`](../src/payments/payments.resolver.ts) |
| Redirect union (form vs URL) | [`src/payments/entities/payment-redirect.entity.ts`](../src/payments/entities/payment-redirect.entity.ts) |
| Seller credentials store | `ChileanPaymentConfig` model in [`prisma/schema.prisma`](../prisma/schema.prisma) |

The adapter is the **only** place that imports `transbank-sdk`. It is
lazy-loaded so the subgraph still boots if the package is missing.

---

## 2. Prerequisites & install

```bash
npm i transbank-sdk          # already in package.json (^6.1.1)
npx prisma generate          # ChileanPaymentConfig / Payment types
```

Node ≥ 22.14 (see `engines` in [`package.json`](../package.json)).

---

## 3. Environment variables

Webpay itself needs **no** global secret — integration uses Transbank's public
test credentials, and production credentials live per-seller in the database.
The surrounding flow does need:

| Var | Used for | Set where |
|---|---|---|
| `GATEWAY_BASE_URL` | Building the public return URL the buyer comes back to | gateway + this service |
| `INTERNAL_SERVICE_SECRET` | Auth on `processProviderReturn` so only the gateway can mark a payment terminal | gateway + this service |

Loaded in [`src/config/configuration.ts`](../src/config/configuration.ts). The
internal secret is enforced in
[`payments.resolver.ts`](../src/payments/payments.resolver.ts) (`_assertInternal`).

---

## 4. Credentials: integration vs production

The adapter picks credentials from the seller's `ChileanPaymentConfig.environment`:

| `environment` | Commerce code | API key | Webpay host |
|---|---|---|---|
| `SANDBOX` | `IntegrationCommerceCodes.WEBPAY_PLUS` = `597055555532` (shared) | `IntegrationApiKeys.WEBPAY` (shared) | `webpay3gint.transbank.cl` |
| `PRODUCTION` | `config.merchantId` (the seller's own) | `config.secretKey` (the seller's own) | `webpay3g.transbank.cl` |

> In `SANDBOX` every seller shares Transbank's public integration credentials —
> fine for development, never for real money. `PRODUCTION` requires the seller
> to have set `merchantId` + `secretKey`; the adapter throws
> `Configuración de Webpay incompleta` otherwise.

`apiKey`/`secretKey`/`merchantId` are **write-only** — they are never returned
by the `getPaymentConfig*` queries.

### Registering a seller's Webpay config

```graphql
mutation {
  createPaymentConfig(input: {
    provider: WEBPAY
    environment: SANDBOX          # or PRODUCTION
    merchantId: "597000000000"    # production only
    secretKey: "••••"             # production only
    isActive: true
    returnUrl: "https://api.ekoru.cl/payments/return/webpay"
  }) {
    id
    provider
    environment
  }
}
```

`sellerId` is taken from the authenticated session, not the input.

---

## 5. The end-to-end flow

```
 Web app            transactions subgraph         Transbank (Webpay)        Gateway
   │                       │                            │                      │
   │ createPayment ───────▶│ tx.create(buyOrder,        │                      │
   │                       │   sessionId, amount,       │                      │
   │                       │   returnUrl) ─────────────▶│                      │
   │                       │◀──── { token, url } ───────│                      │
   │◀── CreatePaymentResult│                            │                      │
   │    (WebpayRedirect:    │                           │                      │
   │     url + token)       │                           │                      │
   │                                                    │                      │
   │ POST form {token_ws} ─────────────────────────────▶│ (card entry on      │
   │                                                    │  Transbank's page)   │
   │                                                    │                      │
   │      buyer pays / aborts / times out               │                      │
   │                                                    │                      │
   │                              POST returnUrl(token_ws / TBK_*) ───────────▶│
   │                       │◀── processProviderReturn(provider, payload, secret)│
   │                       │ tx.commit(token_ws) ──────▶│                      │
   │                       │◀──── auth result ──────────│                      │
   │                       │ → mark Payment COMPLETED/FAILED, Order PAID/CANCELED
   │                       │                            │                      │
   │ poll payment(id){status} (until terminal)          │                      │
```

1. **`createPayment`** ([service](../src/payments/payments.service.ts)) loads
   and validates the order (buyer owns it, status `PENDING_PAYMENT`), resolves
   the seller's Webpay config, persists a `PROCESSING` `Payment`, then calls
   `WebpayAdapter.initiate()` → `tx.create(...)`. It stores `externalId`
   (our `buyOrder`) and `externalToken` (Webpay's `token`) and returns a
   `WebpayRedirect { kind: "WEBPAY_FORM", url, token }`.
2. **Frontend hands off** by POSTing a hidden form (`token_ws`) to `url`
   (Webpay does **not** accept GET — see §7).
3. **Buyer finishes** on Transbank's hosted page. Transbank POSTs back to the
   `returnUrl`.
4. **Gateway** receives that POST at `/payments/return/webpay` and calls the
   internal `processProviderReturn` mutation with the raw body + the internal
   secret.
5. The service finds the payment (**by `token_ws`** for the normal flow — see
   §8 for why) and calls `WebpayAdapter.confirm()`, which commits and maps the
   result to a canonical `PaymentStatus`, then updates the linked `Order`.
6. The web app **polls** `payment(id){ status }` until it leaves `PROCESSING`.

The provider call in step 1 is intentionally **synchronous** — the redirect is
what the buyer is waiting on. BullMQ is reserved for async work (refunds).

---

## 6. Result page requirements ⚠️ (the important part)

Transbank's
["Requerimientos de página de resultado"](https://www.transbankdevelopers.cl/documentacion/como_empezar?l=javascript#requerimientos-de-pagina-de-resultado)
warns that the return URL is **not** only hit on success. It can be reached in
four shapes, and you must **only commit the first one**. Committing an aborted
or timed-out token throws or corrupts state.

`WebpayAdapter.confirm()` classifies the return purely from the POST body:

| `token_ws` | `TBK_TOKEN` | What happened | We do | Resulting `PaymentStatus` |
|:---:|:---:|---|---|---|
| ✅ | — | **Normal** — buyer completed the form (approved *or* declined by the bank) | `tx.commit(token_ws)`, read `response_code` | `COMPLETED` / `FAILED` |
| — | ✅ | **Aborted** — buyer pressed *"Anular compra"* on the Webpay form | do **not** commit | `CANCELLED` |
| — | — | **Timeout** — buyer idle ~10 min; only `TBK_ORDEN_COMPRA` / `TBK_ID_SESION` arrive | do **not** commit | `EXPIRED` |
| ✅ | ✅ | **Abnormal** — both tokens present (double submit / timeout-after-pay) | do **not** commit, log | `FAILED` |

> The classification uses **only the raw return payload**, never the token we
> stored at create time. If `confirm()` fell back to the stored token, an
> aborted return (which has no `token_ws`) would look "normal" and we'd wrongly
> commit it.

On a normal commit, "approved" means `status === "AUTHORIZED"` **and**
`response_code === 0`; anything else is a bank rejection (`FAILED`).

Terminal status is then applied in `_applyTerminalStatus`
([service](../src/payments/payments.service.ts)): `COMPLETED` → `Order` PAID;
`FAILED`/`CANCELLED`/`EXPIRED` → `Order` CANCELED. It is idempotent, so a
duplicate return is safe.

---

## 7. Frontend hand-off (form POST)

Webpay's `url` must be reached with a **POST** carrying `token_ws`. From the
`WebpayRedirect` returned by `createPayment`:

```ts
function redirectToWebpay({ url, token }: { url: string; token: string }) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = url;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'token_ws';
  input.value = token;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}
```

Khipu / MercadoPago instead return `kind: "EXTERNAL"` with a plain `url` you
navigate to with `window.location.href = url`.

---

## 8. GraphQL contract

### Start a payment

```graphql
mutation CreatePayment($input: CreatePaymentInput!) {
  createPayment(input: $input) {
    paymentId
    status
    redirect {
      __typename
      ... on WebpayRedirect { kind url token }
      ... on ExternalRedirect { kind url }
    }
  }
}
```

```jsonc
// variables
{
  "input": {
    "orderId": 1234,
    "provider": "WEBPAY",
    "returnUrl": "https://api.ekoru.cl/payments/return/webpay"
  }
}
```

### Poll until terminal

```graphql
query Status($id: ID!) {
  payment(id: $id) { id status failureReason }
}
```

### Internal — called by the gateway only

```graphql
mutation {
  processProviderReturn(
    provider: WEBPAY
    payload: { token_ws: "e1d4...f9" }   # the raw return body
    internalSecret: "<INTERNAL_SERVICE_SECRET>"
  )
}
```

The gateway sends the secret as the `x-internal-secret` header (preferred) or
the `internalSecret` argument (dev fallback). Without a valid secret the
mutation throws `Unauthorized`.

---

## 9. Gateway responsibilities

This subgraph never receives the buyer's browser directly. The **gateway** owns:

1. **`POST /payments/return/webpay`** — the public `returnUrl`. Reads the
   form body and forwards it to `processProviderReturn(provider: WEBPAY,
   payload: <body>)` with the internal secret, then redirects the browser to
   the web app's confirmation screen.
2. No webhook is needed for Webpay — `handleWebhook()` is a no-op because the
   return POST *is* the only notification. (Khipu/MercadoPago do use
   `/payments/webhook/:provider`.)

---

## 10. Testing in the integration environment

Set the seller config to `environment: SANDBOX` and start the stack:

```bash
npm run start:dev
```

Use Transbank's integration test cards on the hosted page. The most commonly
used (verify the current list on the official docs — Transbank rotates them):

| Card | Number | CVV | Result |
|---|---|---|---|
| VISA (credit) | `4051 8856 0044 6623` | `123` | **Approved** |
| MASTERCARD (credit) | `5186 0595 5959 0568` | `123` | **Rejected** |
| Redcompra (debit) | `4051 8842 3993 7763` | — | **Approved** |
| Redcompra (debit) | `5186 0085 4123 3829` | — | **Rejected** |

For the bank authentication step (credit cards), use **RUT `11.111.111-1`,
password `123`**. Use any future expiry date.

To exercise the §6 edge cases:
- **Abort** → press *"Anular compra"* on the Webpay form → return carries
  `TBK_TOKEN` → payment becomes `CANCELLED`.
- **Timeout** → leave the form idle ~10 min → return carries no token →
  payment becomes `EXPIRED`.

---

## 11. Refunds — current state

`refundPayment` queues a `process-refund` job
([payment.processor.ts](../src/queues/processors/payment.processor.ts)), but
that handler is still a **simulation** — it does not yet call Transbank. The
SDK supports it:

```ts
const tx = new WebpayPlus.Transaction(new Options(commerceCode, apiKey, env));
await tx.refund(token, amount); // token = Payment.externalToken
```

To make refunds real, add a `refund()` method to `ProviderAdapter`, implement
it in `WebpayAdapter` (full amount within the same day → reversal; otherwise →
partial void), and call it from the processor instead of the simulated branch.

---

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `transbank-sdk no está instalado` | Package missing → `npm i transbank-sdk` |
| `Configuración de Webpay incompleta` | `PRODUCTION` config without `merchantId`/`secretKey` |
| `No se encontró el pago para este retorno` | Return body lacked `token_ws` **and** `TBK_ORDEN_COMPRA`; gateway forwarded the wrong body |
| Payment stuck on `PROCESSING` | Return POST never reached the gateway, or `processProviderReturn` failed the secret check |
| `Unauthorized` on `processProviderReturn` | `INTERNAL_SERVICE_SECRET` mismatch between gateway and this service |
| Commit throws on a normal return | Token already committed (Webpay tokens are single-use) — confirm idempotency before retrying |

---

## 13. References

- Cómo empezar (JavaScript): <https://www.transbankdevelopers.cl/documentacion/como_empezar?l=javascript>
- Result page requirements: <https://www.transbankdevelopers.cl/documentacion/como_empezar?l=javascript#requerimientos-de-pagina-de-resultado>
- Webpay Plus reference: <https://www.transbankdevelopers.cl/referencia/webpay>
- SDK source: <https://github.com/TransbankDevelopers/transbank-sdk-nodejs>
