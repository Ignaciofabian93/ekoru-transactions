import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertAdminCan } from '../common/admin-access.js';
import { NotFoundError } from '../common/exceptions/index.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import {
  ConversationItemType,
  ConversationMessageKind,
  ConversationStatus,
} from '../graphql/enums/index.js';
import type {
  AdminConversation,
  ReportedMessage,
} from './entities/reported-message.entity.js';
import type { ConversationMessage } from './entities/conversation.entity.js';

/** How an operator's block is stored in `blockedById`, which holds seller ids. */
export const ADMIN_BLOCK_PREFIX = 'admin:';

type ConversationRow = Prisma.ConversationGetPayload<object>;

/**
 * Chat moderation (ADM-14): reported messages, the thread around them, and
 * blocking. Needs MODERATE_CONTENT. Every action is logged by the admin
 * activity interceptor (USR-12).
 */
@Injectable()
export class ChatAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async reportedMessages({
    adminId,
    page = 1,
    pageSize = 20,
    includeResolved = false,
  }: {
    adminId?: string;
    page?: number;
    pageSize?: number;
    includeResolved?: boolean;
  }) {
    await assertAdminCan(this.prisma, adminId, 'MODERATE_CONTENT');
    const where: Prisma.ConversationMessageWhereInput = {
      reportedAt: { not: null },
      ...(!includeResolved && { reportResolvedAt: null }),
    };
    const { skip, take } = calculatePrismaParams(page, pageSize);
    const [count, rows] = await Promise.all([
      this.prisma.conversationMessage.count({ where }),
      this.prisma.conversationMessage.findMany({
        where,
        orderBy: { reportedAt: 'desc' },
        skip,
        take,
        include: { conversation: true },
      }),
    ]);
    const nodes: ReportedMessage[] = rows.map((row) => ({
      id: row.id,
      body: row.body,
      masked: row.masked,
      senderId: row.senderId,
      sender: row.senderId ? { id: row.senderId } : null,
      createdAt: row.createdAt,
      reportedAt: row.reportedAt as Date,
      reportReason: row.reportReason,
      reporter: row.reportedById ? { id: row.reportedById } : null,
      resolvedAt: row.reportResolvedAt,
      conversation: this.conversationView(row.conversation),
    }));
    return createPaginatedResponse(nodes, count, page, pageSize);
  }

  /** The thread around a report, newest first. */
  async conversationMessages({
    adminId,
    conversationId,
    before,
    limit = 50,
  }: {
    adminId?: string;
    conversationId: number;
    before?: number | null;
    limit?: number;
  }): Promise<{ nodes: ConversationMessage[]; hasMore: boolean }> {
    await assertAdminCan(this.prisma, adminId, 'MODERATE_CONTENT');
    await this.load(conversationId);
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.prisma.conversationMessage.findMany({
      where: { conversationId, ...(before && { id: { lt: before } }) },
      orderBy: { id: 'desc' },
      take: take + 1,
    });
    return {
      nodes: rows.slice(0, take).map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        kind: m.kind as ConversationMessageKind,
        body: m.body,
        masked: m.masked,
        mine: false,
        createdAt: m.createdAt,
      })),
      hasMore: rows.length > take,
    };
  }

  /** The report was reviewed; the message stays. */
  async resolveReport({
    adminId,
    messageId,
  }: {
    adminId?: string;
    messageId: number;
  }): Promise<boolean> {
    await assertAdminCan(this.prisma, adminId, 'MODERATE_CONTENT');
    const message = await this.prisma.conversationMessage.findUnique({
      where: { id: messageId },
      select: { id: true },
    });
    if (!message) throw new NotFoundError('Mensaje no encontrado');
    await this.prisma.conversationMessage.update({
      where: { id: messageId },
      data: { reportResolvedAt: new Date() },
    });
    return true;
  }

  /** Stops the thread for both sides; only an operator can reopen it. */
  async setBlocked({
    adminId,
    conversationId,
    blocked,
  }: {
    adminId?: string;
    conversationId: number;
    blocked: boolean;
  }): Promise<AdminConversation> {
    const admin = await assertAdminCan(
      this.prisma,
      adminId,
      'MODERATE_CONTENT',
    );
    await this.load(conversationId);
    const row = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: blocked
        ? {
            status: ConversationStatus.BLOCKED,
            blockedById: `${ADMIN_BLOCK_PREFIX}${admin}`,
            blockedAt: new Date(),
          }
        : {
            status: ConversationStatus.OPEN,
            blockedById: null,
            blockedAt: null,
          },
    });
    return this.conversationView(row);
  }

  private async load(conversationId: number): Promise<ConversationRow> {
    const row = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!row) throw new NotFoundError('Conversación no encontrada');
    return row;
  }

  private conversationView(row: ConversationRow): AdminConversation {
    return {
      id: row.id,
      itemType: row.itemType as ConversationItemType,
      product: row.productId ? { id: row.productId } : null,
      storeProduct: row.storeProductId ? { id: row.storeProductId } : null,
      service: row.serviceId ? { id: row.serviceId } : null,
      buyer: { id: row.buyerId },
      seller: { id: row.sellerId },
      status: row.status as ConversationStatus,
      blockedByAdmin: Boolean(row.blockedById?.startsWith(ADMIN_BLOCK_PREFIX)),
    };
  }
}
