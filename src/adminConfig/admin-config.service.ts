import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { InternalServerError } from '../common/exceptions/index.js';
import { assertAdminCan } from '../common/admin-access.js';
import {
  pickDefined,
  requireBulkFields,
  processBulkRows,
  bulkErrorMessage,
} from '../common/bulk/index.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import type {
  TransactionFeeUpsertRowInput,
  ShippingStatusUpsertRowInput,
  ChileanPaymentConfigUpsertRowInput,
} from './dto/index.js';

// Columns of ChileanPaymentConfig safe to return to the admin panel — apiKey and
// secretKey are write-only (settable via upsert, never read back).
const PAYMENT_CONFIG_SELECT = {
  id: true,
  sellerId: true,
  provider: true,
  merchantId: true,
  environment: true,
  isActive: true,
  webhookUrl: true,
  returnUrl: true,
  cancelUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Admin CRUD for the transactions subgraph's small config tables. First one:
 * `TransactionFee`, EKORU's commission rate per seller type, applied to every
 * order and quotation payment (CommissionService). Raw reads bypass no filters —
 * these tables have no soft-delete or active flag — so they double as the
 * public reads plus admin write surface.
 */
@Injectable()
export class AdminConfigService {
  private readonly logger = new Logger(AdminConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    await assertAdminCan(this.prisma, adminId, 'MANAGE_SETTINGS');
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
    await assertAdminCan(this.prisma, adminId, 'MANAGE_SETTINGS');

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

      // One commission rate per seller type (TRX-10): a row without an id for
      // a type that already has a rate updates it instead of adding a second
      // one that would silently compete with it.
      if (row.sellerTypeFee) {
        const existing = await this.prisma.transactionFee.findFirst({
          where: { sellerTypeFee: row.sellerTypeFee },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if (existing) {
          await this.prisma.transactionFee.update({
            where: { id: existing.id },
            data,
          });
          return { outcome: 'updated', id: existing.id };
        }
      }
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

  // ─── Shipping statuses ──────────────────────────────────────────────────────

  async getShippingStatuses() {
    try {
      return await this.prisma.shippingStatus.findMany({
        orderBy: { id: 'asc' },
      });
    } catch (error) {
      this.logger.error('Error fetching shipping statuses:', error);
      throw new InternalServerError(bulkErrorMessage(error));
    }
  }

  getShippingStatusById(id: number) {
    return this.prisma.shippingStatus.findUnique({ where: { id } });
  }

  async deleteShippingStatus(adminId: string | undefined, id: number) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_ORDERS');
    try {
      return await this.prisma.shippingStatus.delete({ where: { id } });
    } catch (error) {
      this.logger.error('Error deleting shipping status:', error);
      throw new InternalServerError(bulkErrorMessage(error));
    }
  }

  async bulkUpsertShippingStatuses(
    adminId: string | undefined,
    rows: ShippingStatusUpsertRowInput[],
  ) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_ORDERS');

    return processBulkRows(this.logger, rows, async (row) => {
      const data = pickDefined({ status: row.status });

      if (row.id != null) {
        const id = Number(row.id);
        await this.prisma.shippingStatus.update({ where: { id }, data });
        return { outcome: 'updated', id };
      }

      requireBulkFields(row, ['status']);
      const created = await this.prisma.shippingStatus.create({
        data: { status: row.status! },
      });
      return { outcome: 'created', id: created.id };
    });
  }

  // ─── Chilean payment configs ────────────────────────────────────────────────

  async getChileanPaymentConfigs({
    id,
    page,
    pageSize,
    search,
    provider,
    isActive,
  }: {
    id?: number;
    page: number;
    pageSize: number;
    search?: string;
    provider?: ChileanPaymentConfigUpsertRowInput['provider'];
    isActive?: boolean;
  }) {
    const { skip, take } = calculatePrismaParams(page, pageSize);
    const where = {
      ...(id != null && { id }),
      ...(provider != null && { provider }),
      ...(isActive != null && { isActive }),
      ...(search?.trim() && {
        sellerId: { contains: search.trim(), mode: 'insensitive' as const },
      }),
    };

    const [count, rows] = await Promise.all([
      this.prisma.chileanPaymentConfig.count({ where }),
      this.prisma.chileanPaymentConfig.findMany({
        where,
        orderBy: { id: 'asc' },
        skip,
        take,
        select: PAYMENT_CONFIG_SELECT,
      }),
    ]);

    return createPaginatedResponse(rows, count, page, pageSize);
  }

  async deleteChileanPaymentConfig(adminId: string | undefined, id: number) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_SETTINGS');
    try {
      return await this.prisma.chileanPaymentConfig.delete({ where: { id } });
    } catch (error) {
      this.logger.error('Error deleting payment config:', error);
      throw new InternalServerError(bulkErrorMessage(error));
    }
  }

  async bulkUpsertChileanPaymentConfigs(
    adminId: string | undefined,
    rows: ChileanPaymentConfigUpsertRowInput[],
  ) {
    await assertAdminCan(this.prisma, adminId, 'MANAGE_SETTINGS');

    return processBulkRows(this.logger, rows, async (row) => {
      // apiKey/secretKey only change when a value is provided (write-only).
      const data = pickDefined({
        sellerId: row.sellerId,
        provider: row.provider,
        merchantId: row.merchantId,
        apiKey: row.apiKey,
        secretKey: row.secretKey,
        environment: row.environment,
        isActive: row.isActive,
        webhookUrl: row.webhookUrl,
        returnUrl: row.returnUrl,
        cancelUrl: row.cancelUrl,
      });

      if (row.id != null) {
        const id = Number(row.id);
        await this.prisma.chileanPaymentConfig.update({ where: { id }, data });
        return { outcome: 'updated', id };
      }

      // No id: (sellerId, provider) is unique — match on it to update in place.
      if (row.sellerId && row.provider != null) {
        const existing = await this.prisma.chileanPaymentConfig.findUnique({
          where: {
            sellerId_provider: {
              sellerId: row.sellerId,
              provider: row.provider,
            },
          },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.chileanPaymentConfig.update({
            where: { id: existing.id },
            data,
          });
          return { outcome: 'updated', id: existing.id };
        }
      }

      requireBulkFields(row, ['sellerId', 'provider']);
      const created = await this.prisma.chileanPaymentConfig.create({
        data: {
          sellerId: row.sellerId!,
          provider: row.provider!,
          merchantId: row.merchantId,
          apiKey: row.apiKey,
          secretKey: row.secretKey,
          environment: row.environment ?? undefined,
          isActive: row.isActive ?? undefined,
          webhookUrl: row.webhookUrl,
          returnUrl: row.returnUrl,
          cancelUrl: row.cancelUrl,
        },
      });
      return { outcome: 'created', id: created.id };
    });
  }
}
