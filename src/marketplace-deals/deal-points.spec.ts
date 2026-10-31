import { MarketplaceDealsResolver } from './marketplace-deals.resolver.js';
import { MarketplaceDealsService } from './marketplace-deals.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { P2PStatus } from '../graphql/enums/index.js';
import type { P2PDeal } from './entities/index.js';

const deal = (over: Partial<P2PDeal> = {}) =>
  ({
    id: 12,
    status: P2PStatus.COMPLETED,
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    ...over,
  }) as P2PDeal;

const resolverWith = (pointsCollected: number | null) => {
  const aggregate = jest.fn().mockResolvedValue({ _sum: { pointsCollected } });
  const prisma = {
    transaction: { aggregate },
  } as unknown as PrismaService;
  const resolver = new MarketplaceDealsResolver(
    {} as MarketplaceDealsService,
    prisma,
  );
  return { resolver, aggregate };
};

describe('P2PDeal.myPoints', () => {
  it("reads the viewer's credit for this deal from the ledger", async () => {
    const { resolver, aggregate } = resolverWith(42);
    expect(await resolver.myPoints(deal(), 'buyer-1')).toBe(42);
    expect(aggregate).toHaveBeenCalledWith({
      where: { sellerId: 'buyer-1', notes: 'deal:12' },
      _sum: { pointsCollected: true },
    });
  });

  it('is 0 when the award has not landed', async () => {
    const { resolver } = resolverWith(null);
    expect(await resolver.myPoints(deal(), 'seller-1')).toBe(0);
  });

  it('is null before completion, and for anyone outside the deal', async () => {
    const { resolver, aggregate } = resolverWith(42);
    expect(
      await resolver.myPoints(deal({ status: P2PStatus.ACCEPTED }), 'buyer-1'),
    ).toBeNull();
    expect(await resolver.myPoints(deal(), 'someone-else')).toBeNull();
    expect(await resolver.myPoints(deal(), undefined)).toBeNull();
    expect(aggregate).not.toHaveBeenCalled();
  });
});
