/** The payments BullMQ queue; consumed by queues/processors/payment.processor. */
export const PAYMENT_QUEUE = 'payments';

/** Job names on the payments queue. */
export const PAYMENT_JOBS = {
  refund: 'process-refund',
  stock: 'adjust-stock',
  quotation: 'settle-quotation',
  expire: 'expire-stale',
  mercadoPagoTokens: 'refresh-mercadopago-tokens',
} as const;
