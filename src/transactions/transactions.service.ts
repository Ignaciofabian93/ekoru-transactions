import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  NotFoundError,
  InternalServerError,
} from '../common/exceptions/index.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import { TransactionKind } from '../graphql/enums/index.js';

const TRANSACTION_SELECT = {
  id: true,
  kind: true,
  pointsCollected: true,
  sellerId: true,
  transactionFeeId: true,
  createdAt: true,
  transactionFee: {
    select: {
      id: true,
      sellerTypeFee: true,
      feePercentage: true,
      description: true,
    },
  },
  exchange: {
    select: {
      id: true,
      transactionId: true,
      offeredProductId: true,
      requestedProductId: true,
      status: true,
      notes: true,
      createdAt: true,
      completedAt: true,
    },
  },
} as const;

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getTransaction(id: number) {
    try {
      const tx = await this.prisma.transaction.findUnique({
        where: { id },
        select: TRANSACTION_SELECT,
      });

      if (!tx) throw new NotFoundError('Transacción no encontrada');

      return { ...tx, seller: { id: tx.sellerId } };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      this.logger.error('Error al obtener la transacción:', error);
      throw new InternalServerError('Error al obtener la transacción');
    }
  }

  async getTransactionsBySeller({
    sellerId,
    page,
    pageSize,
    kind,
  }: {
    sellerId: string;
    page: number;
    pageSize: number;
    kind?: TransactionKind;
  }) {
    try {
      const { skip, take } = calculatePrismaParams(page, pageSize);
      const where = { sellerId, ...(kind && { kind }) };

      const count = await this.prisma.transaction.count({ where });
      const txs = await this.prisma.transaction.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: TRANSACTION_SELECT,
      });

      const mapped = txs.map((tx) => ({
        ...tx,
        seller: { id: tx.sellerId },
      }));

      return createPaginatedResponse(mapped, count, page, pageSize);
    } catch (error) {
      this.logger.error('Error al obtener transacciones del vendedor:', error);
      throw new InternalServerError(
        'Error al obtener transacciones del vendedor',
      );
    }
  }

  async getTransactionFees() {
    try {
      return await this.prisma.transactionFee.findMany({
        select: {
          id: true,
          sellerTypeFee: true,
          feePercentage: true,
          description: true,
        },
        orderBy: { sellerTypeFee: 'asc' },
      });
    } catch (error) {
      this.logger.error('Error al obtener las tarifas de transacción:', error);
      throw new InternalServerError(
        'Error al obtener las tarifas de transacción',
      );
    }
  }
}
