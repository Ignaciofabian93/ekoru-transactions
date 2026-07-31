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
  },
  /** Public URL of the gateway. Used to build provider return URLs. */
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL,
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
