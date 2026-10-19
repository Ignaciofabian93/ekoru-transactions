import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checks the `x-signature` header Mercado Pago puts on every webhook (TRX-16).
 *
 * The header reads `ts=<timestamp>,v1=<hex hmac>`. The HMAC-SHA256, keyed with
 * the application's webhook secret, is over the manifest
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` where `data.id` comes from
 * the notification URL's query string, lowercased (order ids are
 * alphanumeric). A part whose value did not arrive is left out of the
 * manifest, as Mercado Pago does.
 *
 * https://www.mercadopago.cl/developers/es/docs/your-integrations/notifications/webhooks
 */
export function verifyMercadoPagoSignature({
  signatureHeader,
  requestId,
  dataId,
  secret,
}: {
  signatureHeader?: string | null;
  requestId?: string | null;
  dataId?: string | null;
  secret?: string | null;
}): boolean {
  if (!signatureHeader || !secret) return false;

  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;

  const manifest =
    (dataId ? `id:${dataId.toLowerCase()};` : '') +
    (requestId ? `request-id:${requestId};` : '') +
    `ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  const received = Buffer.from(v1, 'hex');
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
