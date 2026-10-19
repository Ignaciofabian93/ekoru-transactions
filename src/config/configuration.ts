export default () => ({
  port: parseInt(process.env.PORT || '4007', 10),
  database: {
    url: process.env.DATABASE_URL,
  },
  /**
   * URLs of sibling subgraphs we need to call from this service. Used by
   * MarketplaceClient / StoresClient to look up canonical product prices when
   * the checkout creates an order.
   */
  subgraphs: {
    marketplace: process.env.MARKETPLACE_URL,
    stores: process.env.STORES_URL,
    // Used by UsersClient to price + activate paid subscriptions (Payment
    // receiver = EKORU). Called directly, not through the gateway.
    users: process.env.USERS_URL,
    // Prices and settles quotation payments (TRX-6) through services'
    // internal quotationCharge / markQuotationPaid.
    services: process.env.SERVICES_URL,
  },
  /** Public URL of the gateway. Used to build provider return URLs. */
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL,
  /**
   * Public URL of the web app. Used to deep-link notification emails to the
   * order or deal they describe. Optional: without it the email falls back to
   * a generic account link.
   */
  webAppBaseUrl: process.env.WEB_APP_BASE_URL,
  /**
   * The platform Seller id that owns EKORU's own ChileanPaymentConfig — the
   * receiver of subscription (and later ad) payments. Its Webpay config is what
   * charges land in.
   */
  ekoruPlatformSellerId: process.env.EKORU_PLATFORM_SELLER_ID,
  /**
   * Token shared between the gateway and the transactions service.
   * Required on the internal `/payments/return/*` and `/payments/webhook/*`
   * mutations so only the gateway can mark payments terminal.
   */
  internalSecret: process.env.INTERNAL_SERVICE_SECRET,
  /**
   * Abandoned checkouts (TRX-9): payments still pending and orders still
   * unpaid after `expireAfterMinutes` expire. Webpay's form times out after
   * about ten minutes, so an hour never cuts off a buyer who is paying.
   */
  payments: {
    /**
     * Providers buyers can pay with, comma-separated, first one is the default
     * for memberships. Mercado Pago only since 2026-10-19 (D1); Webpay stays
     * built and comes back by adding it here (`MERCADOPAGO,WEBPAY`).
     */
    enabledProviders: (process.env.PAYMENT_PROVIDERS || 'MERCADOPAGO')
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean),
    expireAfterMinutes: parseInt(
      process.env.PAYMENT_EXPIRE_MINUTES || '60',
      10,
    ),
    expireSweepEveryMin: parseInt(
      process.env.PAYMENT_EXPIRE_SWEEP_MINUTES || '10',
      10,
    ),
  },
  /**
   * EKORU's Mercado Pago application (TRX-5). Stores connect their own
   * Mercado Pago account to it with OAuth, buyers pay the store directly, and
   * EKORU's commission is split off at source (`marketplace_fee`).
   *   - clientId / clientSecret: the application's credentials.
   *   - redirectUri: the panel page Mercado Pago sends the store back to; it
   *     must match one of the application's redirect URLs exactly.
   *   - webhookSecret: the application's webhook signing secret (Webhooks >
   *     Configurar notificaciones). Without it every webhook is refused.
   *   - environment: SANDBOX connects test accounts (test_token), PRODUCTION
   *     real ones. Stored on each connection.
   */
  mercadoPago: {
    clientId: process.env.MERCADOPAGO_CLIENT_ID,
    clientSecret: process.env.MERCADOPAGO_CLIENT_SECRET,
    redirectUri: process.env.MERCADOPAGO_REDIRECT_URI,
    webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
    environment:
      process.env.MERCADOPAGO_ENVIRONMENT === 'PRODUCTION'
        ? 'PRODUCTION'
        : 'SANDBOX',
    authBaseUrl:
      process.env.MERCADOPAGO_AUTH_BASE_URL || 'https://auth.mercadopago.com',
    apiBaseUrl:
      process.env.MERCADOPAGO_API_BASE_URL || 'https://api.mercadopago.com',
    /**
     * PKCE on the authorization code flow. Turn on "flujo de código de
     * autorización con PKCE" in the application; set false only if it is off.
     */
    usePkce: process.env.MERCADOPAGO_USE_PKCE !== 'false',
    /**
     * Ask for TEST- credentials on connect (`test_token`). Off by default:
     * Checkout Pro has no test credentials, so staging uses the production
     * credentials of Mercado Pago test accounts (an "Integrador" owns the app).
     */
    testToken: process.env.MERCADOPAGO_TEST_TOKEN === 'true',
    /** Access tokens last 180 days; refresh the ones expiring within this window. */
    refreshWithinDays: parseInt(
      process.env.MERCADOPAGO_REFRESH_WITHIN_DAYS || '30',
      10,
    ),
  },
  /**
   * Peer-to-peer marketplace deal (anti-scam) tunables. Deals meet in person,
   * cash only; these govern the confirmation window, penalties, the sweep
   * cadence, and the exchange price-gap that forces a cash compensation.
   */
  p2p: {
    confirmWindowHours: parseInt(
      process.env.P2P_CONFIRM_WINDOW_HOURS || '72',
      10,
    ),
    strikeBlockThreshold: parseInt(
      process.env.P2P_STRIKE_BLOCK_THRESHOLD || '3',
      10,
    ),
    blockDays: parseInt(process.env.P2P_BLOCK_DAYS || '30', 10),
    sweepEveryMin: parseInt(process.env.P2P_SWEEP_EVERY_MIN || '15', 10),
    compensationThresholdClp: parseInt(
      process.env.P2P_COMPENSATION_THRESHOLD_CLP || '5000',
      10,
    ),
    completionPoints: parseInt(process.env.P2P_COMPLETION_POINTS || '10', 10),
    // Days a sold/exchanged product lingers in the seller's profile before the
    // sweep soft-deletes it to free space.
    soldRetentionDays: parseInt(process.env.P2P_SOLD_RETENTION_DAYS || '7', 10),
  },
});
