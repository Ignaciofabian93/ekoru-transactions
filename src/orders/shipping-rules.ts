import { BadRequestError } from '../common/exceptions/index.js';

/**
 * Where an order's shipping may move from each stage (TRX-1).
 *
 * PREPARING can go straight to DELIVERED for a pickup at the seller's place.
 * DELIVERED earns the parties their eco-points, so it is not a stage to move
 * back from, except to RETURNED. RETURNED and CANCELED are final; undoing the
 * charge is a refund (TRX-2), not a shipping update.
 */
const NEXT: Record<string, string[]> = {
  PREPARING: ['SHIPPED', 'DELIVERED', 'CANCELED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  RETURNED: [],
  CANCELED: [],
};

/**
 * Only a paid order ships; an unpaid one used to be markable as delivered,
 * which also paid out its eco-points.
 */
export function assertShippingMove({
  orderStatus,
  from,
  to,
}: {
  orderStatus: string;
  from: string;
  to: string;
}): void {
  if (orderStatus !== 'PAID') {
    throw new BadRequestError('Solo se actualiza el envío de una orden pagada');
  }
  if (!(NEXT[from] ?? []).includes(to)) {
    throw new BadRequestError(`El envío no puede pasar de ${from} a ${to}`);
  }
}
