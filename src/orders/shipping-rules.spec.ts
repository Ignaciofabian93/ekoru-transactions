import { BadRequestError } from '../common/exceptions/index.js';
import { assertShippingMove } from './shipping-rules.js';

describe('assertShippingMove', () => {
  const paid = (from: string, to: string) => () =>
    assertShippingMove({ orderStatus: 'PAID', from, to });

  it.each([
    ['PREPARING', 'SHIPPED'],
    ['PREPARING', 'DELIVERED'], // pickup at the seller's place
    ['PREPARING', 'CANCELED'],
    ['SHIPPED', 'DELIVERED'],
    ['SHIPPED', 'RETURNED'],
    ['DELIVERED', 'RETURNED'],
  ])('lets a paid order move %s → %s', (from, to) => {
    expect(paid(from, to)).not.toThrow();
  });

  it.each([
    ['DELIVERED', 'SHIPPED'],
    ['DELIVERED', 'DELIVERED'],
    ['SHIPPED', 'PREPARING'],
    ['CANCELED', 'SHIPPED'],
    ['RETURNED', 'DELIVERED'],
  ])('refuses %s → %s', (from, to) => {
    expect(paid(from, to)).toThrow(BadRequestError);
  });

  it.each(['PENDING_PAYMENT', 'CANCELED', 'REFUNDED'])(
    'refuses any move on a %s order (no delivery, no points, before payment)',
    (orderStatus) => {
      expect(() =>
        assertShippingMove({ orderStatus, from: 'PREPARING', to: 'DELIVERED' }),
      ).toThrow(BadRequestError);
    },
  );
});
