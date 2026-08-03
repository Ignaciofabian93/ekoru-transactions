import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  UnauthorizedError,
  InternalServerError,
} from '../common/exceptions/index.js';
import {
  pickDefined,
  requireBulkFields,
  processBulkRows,
  bulkErrorMessage,
} from '../common/bulk/index.js';
import type { TransactionFeeUpsertRowInput } from './dto/index.js';

/**
 * Admin CRUD for the transactions subgraph's small config tables. First one:
 * `TransactionFee` (one fee per seller type). Raw reads bypass no filters —
 * these tables have no soft-delete or active flag — so they double as the
 * public reads plus admin write surface.
 */
@Injectable()
export class AdminConfigService {
  private readonly logger = new Logger(AdminConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(adminId?: string) {
    if (!adminId) throw new UnauthorizedError('Admins only');
  }

  // ─── Transaction fees ───────────────────────────────────────────────────────

  async getTransactionFees() {
    try {
      return await this.prisma.transactionFee.findMany({
        orderBy: { sellerTypeFee: 'asc' },
      });
    } catch (error) {
      this.logger.error('Error fetching transaction fees:', error);
      throw new InternalServerError(bulkErrorMessage(error));
    }
  }

  getTransactionFeeById(id: number) {
    return this.prisma.transactionFee.findUnique({ where: { id } });
  }

  async deleteTransactionFee(adminId: string | undefined, id: number) {
    this.assertAdmin(adminId);
    try {
      return await this.prisma.transactionFee.delete({ where: { id } });
    } catch (error) {
      this.logger.error('Error deleting transaction fee:', error);
      throw new InternalServerError(bulkErrorMessage(error));
    }
  }

  async bulkUpsertTransactionFees(
    adminId: string | undefined,
    rows: TransactionFeeUpsertRowInput[],
  ) {
    this.assertAdmin(adminId);

    return processBulkRows(this.logger, rows, async (row) => {
      const data = pickDefined({
        sellerTypeFee: row.sellerTypeFee,
        feePercentage: row.feePercentage,
        description: row.description,
      });

      if (row.id != null) {
        const id = Number(row.id);
        await this.prisma.transactionFee.update({ where: { id }, data });
        return { outcome: 'updated', id };
      }

      // `sellerTypeFee` is not unique (multiple fee tiers per type are allowed),
      // so a row without an id always creates.
      requireBulkFields(row, ['sellerTypeFee', 'feePercentage', 'description']);
      const created = await this.prisma.transactionFee.create({
        data: {
          sellerTypeFee: row.sellerTypeFee!,
          feePercentage: row.feePercentage!,
          description: row.description!,
        },
      });
      return { outcome: 'created', id: created.id };
    });
  }
}
