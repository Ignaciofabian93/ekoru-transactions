import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Above this a rate is a typo (5 typed for 5%), never a real commission. */
export const MAX_COMMISSION_RATE = 0.99;

export interface CommissionQuote {
  /** Fraction of the amount EKORU keeps (0.05 = 5%), as `TransactionFee.feePercentage` stores it. */
  rate: number;
  /** EKORU's share, in whole CLP. */
  fee: number;
  /** What the seller keeps, before the provider's own fee. */
  net: number;
  /** The TransactionFee row the rate came from; null when none applies. */
  transactionFeeId: number | null;
}

/**
 * Splits an amount into EKORU's commission and the seller's share. CLP has no
 * decimals, so the fee is rounded to a whole peso, and it never reaches the
 * whole amount.
 */
export function splitCommission(
  amount: number,
  rate: number,
  transactionFeeId: number | null = null,
): CommissionQuote {
  const safeRate =
    Number.isFinite(rate) && rate > 0 ? Math.min(rate, MAX_COMMISSION_RATE) : 0;
  const fee = Math.round(amount * safeRate);
  return { rate: safeRate, fee, net: amount - fee, transactionFeeId };
}

/**
 * EKORU's commission on a sale (TRX-10). The rate is the `TransactionFee` row
 * for the selling seller's type, which platform admins set in the panel
 * ("Comisiones"); with no row the sale carries no commission. Each payment
 * keeps the rate it was charged with, so changing it later never rewrites
 * history.
 */
@Injectable()
export class CommissionService {
  constructor(private readonly prisma: PrismaService) {}

  async quote({
    sellerId,
    amount,
  }: {
    sellerId: string;
    amount: number;
  }): Promise<CommissionQuote> {
    const sellerType = await this.sellerType(sellerId);
    if (!sellerType) return splitCommission(amount, 0);

    // One rate per seller type. Older data may hold several rows for a type;
    // the one edited last is the one in force.
    const row = await this.prisma.transactionFee.findFirst({
      where: { sellerTypeFee: sellerType },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, feePercentage: true },
    });
    return row
      ? splitCommission(amount, row.feePercentage, row.id)
      : splitCommission(amount, 0);
  }

  /** The Seller table belongs to ekoru-users, so it is read with raw SQL. */
  private async sellerType(
    sellerId: string,
  ): Promise<'PERSON' | 'STARTUP' | 'COMPANY' | null> {
    const rows = await this.prisma.$queryRaw<{ sellerType: string }[]>`
      SELECT "sellerType"::text AS "sellerType"
      FROM "Seller"
      WHERE "id" = ${sellerId}
      LIMIT 1`;
    const type = rows[0]?.sellerType;
    return type === 'PERSON' || type === 'STARTUP' || type === 'COMPANY'
      ? type
      : null;
  }
}
