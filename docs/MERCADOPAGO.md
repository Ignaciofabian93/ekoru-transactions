# Mercado Pago — marketplace payments

> Since 2026-10-19 Mercado Pago is the only payment provider (D1). Webpay is
> still built and switched off; see [§8](#8-webpay-as-a-future-option).
> Code: [`src/payments/mercadopago/`](../src/payments/mercadopago/),
> [`providers/mercadopago.adapter.ts`](../src/payments/providers/mercadopago.adapter.ts),
> [`commission.service.ts`](../src/payments/commission.service.ts).

## 1. How the money moves

```
buyer ──pays──▶ store's own Mercado Pago account
                     │
                     ├─ Mercado Pago's fee   (taken first, store's account terms)
                     └─ marketplace_fee ───▶ EKORU's Mercado Pago account
```

- Mercado Pago's **split 1:1**. Each store connects its own account to EKORU's
  application with OAuth, once and for free. It can do it from the web profile
  (**Cobros**, `/profile/payments`) or from the admin panel (**Negocio →
  Cobros**).
- Each charge is created with the store's access token, so the money lands in
  the store's account. EKORU never receives or holds sale money.
- EKORU's commission is passed as `marketplace_fee`. Mercado Pago credits it to
  the account that owns the application, which must be EKORU SpA's.
- A refund is split the same way: the buyer gets everything back, and the store
  and EKORU each return their share proportionally.
- Memberships are paid to EKORU itself, with EKORU's own access token and no
  fee (§5).

## 2. One-time setup in Mercado Pago

There are two applications, because Checkout Pro has no test credentials:
- **Production:** in EKORU SpA's real account. Mercado Pago asks for a seller
  account with identity verification at KYC level 6.
- **Staging:** in an **Integrador** test account, created from the production
  application's Cuentas de prueba. Test stores and test buyers can only pay
  each other, so the staging application's owner must be a test account too.

Do the steps below for each one, in
[Tus integraciones](https://www.mercadopago.cl/developers/panel/app).

1. **Create the application.** Choose Pagos online, then "No" to an
   e-commerce platform, then the product Checkout Pro and the Marketplace
   model.
2. **Redirect URLs** (Detalles de aplicación → Editar). Add each one exactly,
   with no language prefix:
   - production application: `https://admin.ekoru.cl/payment-setup` (panel)
     and `https://<web>/profile/payments` (web);
   - staging application: the same two paths on the staging panel and web.
3. **PKCE.** In the same screen, turn on "flujo de código de autorización con
   PKCE". To leave it off, set `MERCADOPAGO_USE_PKCE=false`.
4. **Webhooks** (Webhooks → Configurar notificaciones):
   - Production URL: `https://<gateway>/payments/webhook/mercadopago`
   - Test URL: the staging gateway's URL with the same path.
   - Topics: **Pagos** (`payment`) and **Vinculación de aplicaciones** (`mp-connect`).
   - Save, then reveal the secret key; it goes in `MERCADOPAGO_WEBHOOK_SECRET`.
5. **Credentials:** the application's `client_id` and `client_secret`.

## 3. Environment (Infisical, folder `/ekoru-transactions`)

| Key | Staging | Production |
|---|---|---|
| `PAYMENT_PROVIDERS` | `MERCADOPAGO` | `MERCADOPAGO` |
| `MERCADOPAGO_CLIENT_ID` | application id | application id |
| `MERCADOPAGO_CLIENT_SECRET` | application secret | application secret |
| `MERCADOPAGO_REDIRECT_URI` | staging panel `/payment-setup` | `https://admin.ekoru.cl/payment-setup` |
| `MERCADOPAGO_WEB_REDIRECT_URI` | staging web `/profile/payments` | `https://<web>/profile/payments` |
| `PAYMENT_SECRETS_KEY` | `openssl rand -base64 32` | a different `openssl rand -base64 32` |
| `MERCADOPAGO_WEBHOOK_SECRET` | webhook secret | webhook secret |
| `MERCADOPAGO_ENVIRONMENT` | `SANDBOX` | `PRODUCTION` |
| `MERCADOPAGO_USE_PKCE` | optional, default `true` | optional, default `true` |
| `MERCADOPAGO_TEST_TOKEN` | leave unset (`false`) | leave unset |

`PAYMENT_SECRETS_KEY` seals the stores' tokens and Webpay keys at rest
(TRX-21). Production refuses to store a credential without it. Losing it makes
every stored token unreadable, and stores would have to connect again, so keep
it in Infisical, which is backed up. Plain-text rows from before it existed
are sealed on the next boot.

`GATEWAY_BASE_URL` must be the gateway's public URL: it builds the webhook URL
on each preference. Without `MERCADOPAGO_WEBHOOK_SECRET` every webhook is
refused. Payments still settle through the buyer's return and the reconcile job
(§6), but slower.

## 4. Commission

Platform admins set it in the panel under **Comisiones** (`transaction-fees`).

- There is one rate per seller type (PERSON, STARTUP, COMPANY), typed as a
  percent and stored as a fraction (`feePercentage` 0.05 = 5 %).
- A seller type without a row pays no commission.
- Every order and quotation payment keeps its rate (`Payment.feePercentage`),
  its fee (`fees`) and the seller's net before Mercado Pago's own fee
  (`netAmount`). Changing the rate never rewrites past payments.
- The payment detail screen in the panel shows the commission and net. The
  revenue stats sum `fees`.

## 5. Memberships (payments to EKORU)

EKORU's platform seller (`EKORU_PLATFORM_SELLER_ID`) needs its own MERCADOPAGO
row in **Configuración de pagos**:

- `merchantId`: EKORU's Mercado Pago user id.
- `secretKey`: EKORU's production access token (`APP_USR-…`), from Producción →
  Credenciales de producción. On staging, use the Integrador test account's
  production access token, with its user id as `merchantId`.
- `environment`: PRODUCTION on prod, SANDBOX on staging.

## 6. What happens when

- **The store connects.** It clicks "Conectar Mercado Pago" in the web's
  Cobros (as the business) or the panel's (as a BUSINESS admin), and
  authorizes on Mercado Pago.
  - Mercado Pago sends it back to where it started, `/profile/payments` or
    `/payment-setup`, with `?code&state`, and that page calls
    `completeMercadoPagoConnection`.
  - The state is signed and carries the store, who started and where. Only
    that same person can finish, within 15 minutes.
- **Checkout.** `createOrder` refuses a seller without an active connection
  (TRX-4), and `Seller.canReceivePayments` tells the web to hide buy buttons.
  The preference uses `binary_mode`, so a charge is approved or rejected at
  once. It expires 5 minutes before the expiry sweep gives up on the payment.
- **The buyer comes back.** The return URL names the Mercado Pago payment. It
  is read back from the API, and its reference and amount must match ours.
- **Webhook.** `x-signature` must verify, or nothing changes and a 500 makes
  Mercado Pago retry. The store's token is found from the `ekoru_payment` hint
  on the notification URL, or else from the account's `user_id`. The payment is
  then read back from the API.
- **The buyer never returns and the webhook is lost.** Before each expiry
  sweep, payments past the window are looked up by reference (`reconcileStale`):
  - paid ones settle;
  - the rest expire.

  A charge that still lands on an expired payment settles, and settlement
  refunds it because the order is gone.
- **Refund.** `POST /v1/payments/{id}/refunds` with the store's token,
  idempotent per refund row.
- **Tokens.** They last 180 days. A daily job renews those expiring within 30
  days. If Mercado Pago refuses a renewal, the connection pauses and the panel
  asks the store to reconnect.
- **The store disconnects.** New sales stop. The token is kept so refunds of
  past sales still work. Unlinking EKORU inside Mercado Pago sends an
  `mp-connect` webhook that pauses the connection too.

## 7. Testing on staging

1. In the production application's Cuentas de prueba, create three test
   accounts, all in Chile:
   - an **Integrador**, which owns the staging application (§2);
   - a **Vendedor**, which plays a store;
   - a **Comprador**, which plays a buyer.
2. Sign in to the panel as a BUSINESS admin of a test store, open **Cobros** and
   connect while signed in to Mercado Pago as the test Vendedor. Use a private
   window, so you are not signed in as EKORU. The connection uses the test
   accounts' production credentials, so `test_token` stays off.
3. Buy as the test buyer with Mercado Pago's test cards.
4. Check the results:
   - the order is PAID;
   - the payment shows the commission;
   - the PaymentWebhook row is `processed`;
   - in the test seller's Mercado Pago activity, the fee is split off.
5. Refund from the panel and check that both shares go back.

## 8. Webpay as a future option

The Webpay adapter, its sandbox seeds and the panel config are untouched. To
offer it again:

1. Add it to `PAYMENT_PROVIDERS` (`MERCADOPAGO,WEBPAY`).
2. Flip `enabled` for WEBPAY in the web's
   `features/cart/constants/paymentProviders.ts` and the mobile app's
   `features/cart/constants/shippingMethods.ts`.

Webpay cannot split at source, so its payments record the commission without
collecting it.
