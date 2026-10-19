import {
  CommissionService,
  MAX_COMMISSION_RATE,
  splitCommission,
} from './commission.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function make({
  sellerType,
  fee,
}: {
  sellerType?: string;
  fee?: { id: number; feePercentage: number } | null;
}) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(sellerType ? [{ sellerType }] : []),
    transactionFee: { findFirst: jest.fn().mockResolvedValue(fee ?? null) },
  };
  return {
    service: new CommissionService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe('splitCommission', () => {
  it('rounds the fee to a whole peso and gives the seller the rest', () => {
    expect(splitCommission(19990, 0.05, 3)).toEqual({
      rate: 0.05,
      fee: 1000,
      net: 18990,
      transactionFeeId: 3,
    });
  });

  it('charges nothing for a zero, negative or missing rate', () => {
    expect(splitCommission(10000, 0).fee).toBe(0);
    expect(splitCommission(10000, -0.1).fee).toBe(0);
    expect(splitCommission(10000, Number.NaN).fee).toBe(0);
  });

  it('never takes the whole amount, even from a mistyped rate', () => {
    const quote = splitCommission(10000, 5);
    expect(quote.rate).toBe(MAX_COMMISSION_RATE);
    expect(quote.net).toBeGreaterThan(0);
  });
});

describe('CommissionService.quote', () => {
  it("uses the rate set for the seller's type", async () => {
    const { service, prisma } = make({
      sellerType: 'COMPANY',
      fee: { id: 2, feePercentage: 0.08 },
    });

    const quote = await service.quote({ sellerId: 's1', amount: 50000 });

    expect(prisma.transactionFee.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sellerTypeFee: 'COMPANY' } }),
    );
    expect(quote).toEqual({
      rate: 0.08,
      fee: 4000,
      net: 46000,
      transactionFeeId: 2,
    });
  });

  it('charges nothing when no rate is set for the type', async () => {
    const { service } = make({ sellerType: 'STARTUP', fee: null });
    const quote = await service.quote({ sellerId: 's1', amount: 50000 });
    expect(quote).toEqual({
      rate: 0,
      fee: 0,
      net: 50000,
      transactionFeeId: null,
    });
  });

  it('charges nothing for an unknown seller', async () => {
    const { service, prisma } = make({});
    const quote = await service.quote({ sellerId: 'gone', amount: 50000 });
    expect(quote.fee).toBe(0);
    expect(prisma.transactionFee.findFirst).not.toHaveBeenCalled();
  });
});
