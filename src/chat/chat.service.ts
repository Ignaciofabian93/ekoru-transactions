import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersClient } from '../common/clients/users.client.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../common/exceptions/index.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import {
  ConversationItemType,
  ConversationMessageKind,
  ConversationRole,
  ConversationStatus,
} from '../graphql/enums/index.js';
import { haveTraded, maskContactDetails } from './contact-masking.js';
import type { ConversationMessage as MessageView } from './entities/conversation.entity.js';

export const MAX_MESSAGE_LENGTH = 2000;
/** Messages one sender may send per minute, across all their threads. */
export const MESSAGES_PER_MINUTE = 20;
const DEFAULT_MESSAGE_PAGE = 30;
const MAX_MESSAGE_PAGE = 100;
/** Characters of a message shown in its notification. */
const PREVIEW_LENGTH = 140;

type ConversationRow = Prisma.ConversationGetPayload<object>;
type MessageRow = Prisma.ConversationMessageGetPayload<object>;

/**
 * A conversation as the GraphQL `Conversation` type, from one participant's
 * side. `buyerId`/`sellerId` ride along unexposed for the lazy
 * `contactAllowed` field.
 */
export interface ConversationRecord {
  id: number;
  itemType: ConversationItemType;
  product: { id: number } | null;
  storeProduct: { id: number } | null;
  service: { id: number } | null;
  buyer: { id: string };
  seller: { id: string };
  counterpart: { id: string };
  myRole: ConversationRole;
  status: ConversationStatus;
  blockedByMe: boolean;
  unreadCount: number;
  lastMessage: MessageView | null;
  lastMessageAt: Date;
  createdAt: Date;
  buyerId: string;
  sellerId: string;
}

/**
 * Chat between buyers and sellers (TRX-18): one thread per buyer, seller and
 * item, readable and writable only by those two. Contact details are masked
 * until they have traded (TRX-19), and the recipient is notified once per
 * unread burst (USR-13). Clients poll; there is no push channel yet.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * Opens the thread about an item, or returns the one that exists. A buyer
   * opens it with the item's owner. The owner can open it too, from a deal,
   * order or booking, by naming the other side as `counterpartId`; that needs
   * a trade between them on this item, so owners cannot message just anyone.
   */
  async startConversation({
    callerId,
    itemType,
    itemId,
    counterpartId,
    message,
  }: {
    callerId: string;
    itemType: ConversationItemType;
    itemId: number;
    counterpartId?: string | null;
    message?: string | null;
  }): Promise<ConversationRecord> {
    const item = await this.loadItem(itemType, itemId);
    if (!item) throw new NotFoundError('Publicación no encontrada');

    const callerOwnsItem = item.sellerId === callerId;
    if (callerOwnsItem && (!counterpartId || counterpartId === callerId)) {
      throw new BadRequestError('No puedes escribirte a ti mismo');
    }
    const buyerId = callerOwnsItem ? (counterpartId as string) : callerId;

    const key = {
      buyerId,
      sellerId: item.sellerId,
      itemKey: `${itemType}:${itemId}`,
    };
    let conversation = await this.prisma.conversation.findUnique({
      where: { buyerId_sellerId_itemKey: key },
    });
    if (!conversation) {
      const traded = await this.haveTradedOnItem(
        itemType,
        itemId,
        buyerId,
        item.sellerId,
      );
      if (callerOwnsItem && !traded) {
        throw new ForbiddenError(
          'Solo puedes escribir a quien tiene un trato contigo por esta publicación',
        );
      }
      // A sold or paused item starts no new thread, unless the two already
      // traded on it and need to talk about that.
      if (!item.available && !traded) {
        throw new BadRequestError('Esta publicación ya no está disponible');
      }
      // Upsert, not create: two quick clicks must not race into an error.
      conversation = await this.prisma.conversation.upsert({
        where: { buyerId_sellerId_itemKey: key },
        update: {},
        create: {
          ...key,
          itemType,
          productId: itemType === ConversationItemType.PRODUCT ? itemId : null,
          storeProductId:
            itemType === ConversationItemType.STORE_PRODUCT ? itemId : null,
          serviceId: itemType === ConversationItemType.SERVICE ? itemId : null,
        },
      });
    }

    if (message?.trim()) {
      await this.sendMessage({
        conversationId: conversation.id,
        senderId: callerId,
        body: message,
      });
    }
    return this.getConversation({
      conversationId: conversation.id,
      viewerId: callerId,
    });
  }

  async sendMessage({
    conversationId,
    senderId,
    body,
  }: {
    conversationId: number;
    senderId: string;
    body: string;
  }): Promise<MessageView> {
    const text = body.trim();
    if (!text) throw new BadRequestError('El mensaje está vacío');
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestError(
        `El mensaje supera los ${MAX_MESSAGE_LENGTH} caracteres`,
      );
    }

    const conversation = await this.loadForParticipant(
      conversationId,
      senderId,
    );
    if (conversation.status === 'BLOCKED') {
      throw new BadRequestError('Esta conversación está bloqueada');
    }

    const recent = await this.prisma.conversationMessage.count({
      where: { senderId, createdAt: { gte: new Date(Date.now() - 60_000) } },
    });
    if (recent >= MESSAGES_PER_MINUTE) {
      throw new BadRequestError(
        'Estás enviando mensajes muy rápido. Espera un momento.',
      );
    }

    const traded = await haveTraded(
      this.prisma,
      conversation.buyerId,
      conversation.sellerId,
    );
    const { body: safeBody, masked } = traded
      ? { body: text, masked: false }
      : maskContactDetails(text);

    const isBuyer = senderId === conversation.buyerId;
    const recipientId = isBuyer ? conversation.sellerId : conversation.buyerId;
    const recipientReadAt = isBuyer
      ? conversation.sellerLastReadAt
      : conversation.buyerLastReadAt;
    const now = new Date();

    const [message] = await this.prisma.$transaction([
      this.prisma.conversationMessage.create({
        data: { conversationId, senderId, body: safeBody, masked },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: now,
          // Writing in a thread means having read it.
          ...(isBuyer ? { buyerLastReadAt: now } : { sellerLastReadAt: now }),
        },
      }),
    ]);

    // One notice per unread burst: only when the recipient had read
    // everything before this message.
    const unreadBefore = await this.prisma.conversationMessage.count({
      where: {
        conversationId,
        id: { not: message.id },
        OR: [{ senderId: null }, { senderId: { not: recipientId } }],
        ...(recipientReadAt && { createdAt: { gt: recipientReadAt } }),
      },
    });
    if (unreadBefore === 0) {
      void this.users.notifyNewMessage(recipientId, {
        conversationId,
        senderId,
        preview: safeBody.slice(0, PREVIEW_LENGTH),
        url: this.threadUrl(conversationId),
      });
    }

    return this.messageView(message, senderId);
  }

  async markRead({
    conversationId,
    viewerId,
  }: {
    conversationId: number;
    viewerId: string;
  }): Promise<boolean> {
    const conversation = await this.loadForParticipant(
      conversationId,
      viewerId,
    );
    const now = new Date();
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data:
        viewerId === conversation.buyerId
          ? { buyerLastReadAt: now }
          : { sellerLastReadAt: now },
    });
    return true;
  }

  /** The caller's threads with at least one message, most recent first. */
  async myConversations({
    viewerId,
    page = 1,
    pageSize = 20,
  }: {
    viewerId: string;
    page?: number;
    pageSize?: number;
  }) {
    const where: Prisma.ConversationWhereInput = {
      OR: [{ buyerId: viewerId }, { sellerId: viewerId }],
      messages: { some: {} },
    };
    const { skip, take } = calculatePrismaParams(page, pageSize);
    const [count, rows] = await Promise.all([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take,
        include: { messages: { orderBy: { id: 'desc' }, take: 1 } },
      }),
    ]);
    const unread = await this.unreadByConversation(
      rows.map((row) => row.id),
      viewerId,
    );
    const nodes = rows.map((row) =>
      this.view(
        row,
        viewerId,
        row.messages[0] ?? null,
        unread.get(row.id) ?? 0,
      ),
    );
    return createPaginatedResponse(nodes, count, page, pageSize);
  }

  async getConversation({
    conversationId,
    viewerId,
  }: {
    conversationId: number;
    viewerId: string;
  }): Promise<ConversationRecord> {
    const row = await this.loadForParticipant(conversationId, viewerId);
    const [last, unread] = await Promise.all([
      this.prisma.conversationMessage.findFirst({
        where: { conversationId },
        orderBy: { id: 'desc' },
      }),
      this.unreadByConversation([conversationId], viewerId),
    ]);
    return this.view(row, viewerId, last, unread.get(conversationId) ?? 0);
  }

  /**
   * Messages newest first. `before` pages back through history; `after`
   * returns only what arrived since the last poll.
   */
  async conversationMessages({
    conversationId,
    viewerId,
    before,
    after,
    limit = DEFAULT_MESSAGE_PAGE,
  }: {
    conversationId: number;
    viewerId: string;
    before?: number | null;
    after?: number | null;
    limit?: number;
  }): Promise<{ nodes: MessageView[]; hasMore: boolean }> {
    await this.loadForParticipant(conversationId, viewerId);
    const take = Math.min(Math.max(limit, 1), MAX_MESSAGE_PAGE);

    if (after) {
      const rows = await this.prisma.conversationMessage.findMany({
        where: { conversationId, id: { gt: after } },
        orderBy: { id: 'desc' },
        take: MAX_MESSAGE_PAGE,
      });
      return {
        nodes: rows.map((m) => this.messageView(m, viewerId)),
        hasMore: false,
      };
    }

    const rows = await this.prisma.conversationMessage.findMany({
      where: { conversationId, ...(before && { id: { lt: before } }) },
      orderBy: { id: 'desc' },
      take: take + 1,
    });
    return {
      nodes: rows.slice(0, take).map((m) => this.messageView(m, viewerId)),
      hasMore: rows.length > take,
    };
  }

  /** Threads with something the caller has not read, for the badge. */
  async unreadConversationCount(viewerId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
        FROM "Conversation" c
       WHERE (c."buyerId" = ${viewerId} OR c."sellerId" = ${viewerId})
         AND EXISTS (
           SELECT 1 FROM "ConversationMessage" m
            WHERE m."conversationId" = c.id
              AND m."senderId" IS DISTINCT FROM ${viewerId}
              AND m."createdAt" > COALESCE(
                CASE WHEN c."buyerId" = ${viewerId}
                     THEN c."buyerLastReadAt" ELSE c."sellerLastReadAt" END,
                'epoch'::timestamp)
         )
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async reportMessage({
    messageId,
    viewerId,
    reason,
  }: {
    messageId: number;
    viewerId: string;
    reason?: string | null;
  }): Promise<boolean> {
    const message = await this.prisma.conversationMessage.findUnique({
      where: { id: messageId },
    });
    if (!message) throw new NotFoundError('Mensaje no encontrado');
    await this.loadForParticipant(message.conversationId, viewerId);
    if (message.senderId === viewerId) {
      throw new BadRequestError('No puedes reportar tus propios mensajes');
    }
    await this.prisma.conversationMessage.update({
      where: { id: messageId },
      data: {
        reportedAt: new Date(),
        reportedById: viewerId,
        reportReason: reason?.trim().slice(0, 500) || null,
        reportResolvedAt: null,
      },
    });
    return true;
  }

  /** Stops new messages both ways. Only the participant who blocked can undo it. */
  async setBlocked({
    conversationId,
    viewerId,
    blocked,
  }: {
    conversationId: number;
    viewerId: string;
    blocked: boolean;
  }): Promise<ConversationRecord> {
    const conversation = await this.loadForParticipant(
      conversationId,
      viewerId,
    );
    if (
      !blocked &&
      conversation.blockedById &&
      conversation.blockedById !== viewerId
    ) {
      throw new ForbiddenError(
        'Solo quien bloqueó la conversación puede desbloquearla',
      );
    }
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: blocked
        ? {
            status: ConversationStatus.BLOCKED,
            blockedById: viewerId,
            blockedAt: new Date(),
          }
        : {
            status: ConversationStatus.OPEN,
            blockedById: null,
            blockedAt: null,
          },
    });
    return this.getConversation({ conversationId, viewerId });
  }

  contactAllowed(conversation: { buyerId: string; sellerId: string }) {
    return haveTraded(this.prisma, conversation.buyerId, conversation.sellerId);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** A thread the caller takes part in; anyone else gets "not found". */
  private async loadForParticipant(
    conversationId: number,
    viewerId: string,
  ): Promise<ConversationRow> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (
      !conversation ||
      (conversation.buyerId !== viewerId && conversation.sellerId !== viewerId)
    ) {
      throw new NotFoundError('Conversación no encontrada');
    }
    return conversation;
  }

  /** Who owns the item, and whether it can still start a thread. */
  private async loadItem(
    itemType: ConversationItemType,
    itemId: number,
  ): Promise<{ sellerId: string; available: boolean } | null> {
    let rows: { sellerId: string | null; available: boolean }[];
    switch (itemType) {
      case ConversationItemType.PRODUCT:
        rows = await this.prisma.$queryRaw`
          SELECT "sellerId",
                 ("isActive" AND "deletedAt" IS NULL AND "soldAt" IS NULL) AS available
            FROM "Product" WHERE id = ${itemId}`;
        break;
      case ConversationItemType.STORE_PRODUCT:
        rows = await this.prisma.$queryRaw`
          SELECT "sellerId", ("isActive" AND "deletedAt" IS NULL) AS available
            FROM "StoreProduct" WHERE id = ${itemId}`;
        break;
      case ConversationItemType.SERVICE:
        rows = await this.prisma.$queryRaw`
          SELECT "sellerId", "isActive" AS available
            FROM "Service" WHERE id = ${itemId}`;
        break;
      default:
        throw new BadRequestError('Tipo de publicación no válido');
    }
    const row = rows[0];
    return row?.sellerId
      ? { sellerId: row.sellerId, available: row.available }
      : null;
  }

  /**
   * Whether two sellers have a deal, order, booking or quote on this item, in
   * any state. Lets the owner open a thread from that trade, and lets either
   * side talk about an item that has since sold.
   */
  private async haveTradedOnItem(
    itemType: ConversationItemType,
    itemId: number,
    a: string,
    b: string,
  ): Promise<boolean> {
    let rows: { traded: boolean }[];
    switch (itemType) {
      case ConversationItemType.PRODUCT:
        rows = await this.prisma.$queryRaw`
          SELECT EXISTS (
            SELECT 1 FROM "P2PDeal"
             WHERE ${itemId} IN ("productId", "requestedProductId")
               AND (("buyerId" = ${a} AND "sellerId" = ${b})
                 OR ("buyerId" = ${b} AND "sellerId" = ${a}))
          ) AS "traded"`;
        break;
      case ConversationItemType.STORE_PRODUCT:
        rows = await this.prisma.$queryRaw`
          SELECT EXISTS (
            SELECT 1 FROM "Order" o
              JOIN "OrderItem" i ON i."orderId" = o.id
             WHERE i."storeProductId" = ${itemId}
               AND ((o."buyerId" = ${a} AND o."sellerId" = ${b})
                 OR (o."buyerId" = ${b} AND o."sellerId" = ${a}))
          ) AS "traded"`;
        break;
      case ConversationItemType.SERVICE:
        rows = await this.prisma.$queryRaw`
          SELECT EXISTS (
            SELECT 1 FROM "ServiceBooking"
             WHERE "serviceId" = ${itemId}
               AND (("clientId" = ${a} AND "providerId" = ${b})
                 OR ("clientId" = ${b} AND "providerId" = ${a}))
            UNION ALL
            SELECT 1 FROM "Quotation"
             WHERE "serviceId" = ${itemId}
               AND (("clientId" = ${a} AND "providerId" = ${b})
                 OR ("clientId" = ${b} AND "providerId" = ${a}))
          ) AS "traded"`;
        break;
      default:
        return false;
    }
    return rows[0]?.traded === true;
  }

  /** Unread messages per thread, from the caller's side, in one query. */
  private async unreadByConversation(
    ids: number[],
    viewerId: string,
  ): Promise<Map<number, number>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: number; count: bigint }[]>`
      SELECT c.id, count(m.id) AS count
        FROM "Conversation" c
        JOIN "ConversationMessage" m ON m."conversationId" = c.id
       WHERE c.id = ANY(${ids}::int[])
         AND m."senderId" IS DISTINCT FROM ${viewerId}
         AND m."createdAt" > COALESCE(
           CASE WHEN c."buyerId" = ${viewerId}
                THEN c."buyerLastReadAt" ELSE c."sellerLastReadAt" END,
           'epoch'::timestamp)
       GROUP BY c.id
    `;
    return new Map(rows.map((row) => [row.id, Number(row.count)]));
  }

  private view(
    row: ConversationRow,
    viewerId: string,
    last: MessageRow | null,
    unreadCount: number,
  ): ConversationRecord {
    const isBuyer = row.buyerId === viewerId;
    return {
      id: row.id,
      itemType: row.itemType as ConversationItemType,
      product: row.productId ? { id: row.productId } : null,
      storeProduct: row.storeProductId ? { id: row.storeProductId } : null,
      service: row.serviceId ? { id: row.serviceId } : null,
      buyer: { id: row.buyerId },
      seller: { id: row.sellerId },
      counterpart: { id: isBuyer ? row.sellerId : row.buyerId },
      myRole: isBuyer ? ConversationRole.BUYER : ConversationRole.SELLER,
      status: row.status as ConversationStatus,
      blockedByMe: row.blockedById === viewerId,
      unreadCount,
      lastMessage: last ? this.messageView(last, viewerId) : null,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
      buyerId: row.buyerId,
      sellerId: row.sellerId,
    };
  }

  private messageView(message: MessageRow, viewerId: string): MessageView {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      kind: message.kind as ConversationMessageKind,
      body: message.body,
      masked: message.masked,
      mine: message.senderId === viewerId,
      createdAt: message.createdAt,
    };
  }

  private threadUrl(conversationId: number): string {
    const base = this.config.get<string>('webAppBaseUrl');
    return base ? `${base}/profile/messages?c=${conversationId}` : '';
  }
}
