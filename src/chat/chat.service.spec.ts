import { ConfigService } from '@nestjs/config';
import { ChatService, MESSAGES_PER_MINUTE } from './chat.service.js';
import { MASK } from './contact-masking.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersClient } from '../common/clients/users.client.js';
import {
  ConversationItemType,
  ConversationRole,
} from '../graphql/enums/index.js';

const BUYER = 'buyer-1';
const SELLER = 'seller-1';

const conversationRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  buyerId: BUYER,
  sellerId: SELLER,
  itemType: 'PRODUCT',
  productId: 12,
  storeProductId: null,
  serviceId: null,
  itemKey: 'PRODUCT:12',
  status: 'OPEN',
  blockedById: null,
  blockedAt: null,
  lastMessageAt: new Date('2026-10-13T10:00:00Z'),
  buyerLastReadAt: null,
  sellerLastReadAt: null,
  createdAt: new Date('2026-10-13T09:00:00Z'),
  updatedAt: new Date('2026-10-13T10:00:00Z'),
  ...over,
});

describe('ChatService (TRX-18)', () => {
  /** Answers raw SQL by what it reads: the item, the trade check, unread counts. */
  const raw = {
    item: [{ sellerId: SELLER, available: true }] as unknown[],
    traded: false,
  };
  const prisma = {
    conversation: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    conversationMessage: {
      create: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('AS "traded"')) {
        return Promise.resolve([{ traded: raw.traded }]);
      }
      if (sql.includes('GROUP BY c.id')) return Promise.resolve([]);
      return Promise.resolve(raw.item);
    }),
  };
  const users = { notifyNewMessage: jest.fn().mockResolvedValue(true) };
  const config = { get: () => 'https://app.ekoru.cl' };
  const service = new ChatService(
    prisma as unknown as PrismaService,
    users as unknown as UsersClient,
    config as unknown as ConfigService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    raw.item = [{ sellerId: SELLER, available: true }];
    raw.traded = false;
    prisma.conversation.findUnique.mockResolvedValue(conversationRow());
    prisma.conversation.upsert.mockResolvedValue(conversationRow());
    prisma.conversationMessage.count.mockResolvedValue(0);
    prisma.conversationMessage.findFirst.mockResolvedValue(null);
    prisma.conversationMessage.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 99,
          kind: 'TEXT',
          createdAt: new Date(),
          ...data,
        }),
    );
  });

  describe('startConversation', () => {
    it('opens one thread per buyer, seller and item', async () => {
      prisma.conversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue(conversationRow());

      const thread = await service.startConversation({
        callerId: BUYER,
        itemType: ConversationItemType.PRODUCT,
        itemId: 12,
      });

      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            buyerId_sellerId_itemKey: {
              buyerId: BUYER,
              sellerId: SELLER,
              itemKey: 'PRODUCT:12',
            },
          },
        }),
      );
      expect(thread).toMatchObject({
        myRole: ConversationRole.BUYER,
        counterpart: { id: SELLER },
        product: { id: 12 },
      });
    });

    it('refuses messaging yourself and missing items', async () => {
      await expect(
        service.startConversation({
          callerId: SELLER,
          itemType: ConversationItemType.PRODUCT,
          itemId: 12,
        }),
      ).rejects.toThrow('No puedes escribirte a ti mismo');

      raw.item = [];
      await expect(
        service.startConversation({
          callerId: BUYER,
          itemType: ConversationItemType.SERVICE,
          itemId: 3,
        }),
      ).rejects.toThrow('Publicación no encontrada');
    });

    it('starts no new thread on a sold item, but reopens an existing one', async () => {
      raw.item = [{ sellerId: SELLER, available: false }];
      prisma.conversation.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.startConversation({
          callerId: BUYER,
          itemType: ConversationItemType.PRODUCT,
          itemId: 12,
        }),
      ).rejects.toThrow('ya no está disponible');

      await expect(
        service.startConversation({
          callerId: BUYER,
          itemType: ConversationItemType.PRODUCT,
          itemId: 12,
        }),
      ).resolves.toMatchObject({ id: 7 });
    });

    it('lets the owner open a thread with someone they traded with on the item', async () => {
      prisma.conversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue(conversationRow());
      raw.traded = true;

      const thread = await service.startConversation({
        callerId: SELLER,
        itemType: ConversationItemType.PRODUCT,
        itemId: 12,
        counterpartId: BUYER,
      });

      expect(prisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ buyerId: BUYER, sellerId: SELLER }),
        }),
      );
      expect(thread).toMatchObject({
        myRole: ConversationRole.SELLER,
        counterpart: { id: BUYER },
      });
    });

    it('stops the owner messaging someone they never traded with', async () => {
      prisma.conversation.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.startConversation({
          callerId: SELLER,
          itemType: ConversationItemType.PRODUCT,
          itemId: 12,
          counterpartId: 'stranger',
        }),
      ).rejects.toThrow('Solo puedes escribir');
    });

    it('lets traders talk about an item that has since sold', async () => {
      raw.item = [{ sellerId: SELLER, available: false }];
      raw.traded = true;
      prisma.conversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue(conversationRow());

      await expect(
        service.startConversation({
          callerId: BUYER,
          itemType: ConversationItemType.PRODUCT,
          itemId: 12,
        }),
      ).resolves.toMatchObject({ id: 7 });
    });
  });

  describe('sendMessage', () => {
    const send = (senderId: string, body: string) =>
      service.sendMessage({ conversationId: 7, senderId, body });

    it('keeps outsiders out', async () => {
      await expect(send('stranger', 'hola')).rejects.toThrow(
        'Conversación no encontrada',
      );
    });

    it('masks contact details until the two have traded (TRX-19)', async () => {
      const message = await send(BUYER, 'llámame al +56 9 8765 4321');
      expect(message).toMatchObject({
        body: `llámame al ${MASK}`,
        masked: true,
        mine: true,
      });

      raw.traded = true;
      await expect(
        send(BUYER, 'llámame al +56 9 8765 4321'),
      ).resolves.toMatchObject({
        body: 'llámame al +56 9 8765 4321',
        masked: false,
      });
    });

    it('marks the thread read for the sender and moves it to the top', async () => {
      await send(SELLER, 'Sí, sigue disponible');

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: expect.objectContaining({
          lastMessageAt: expect.any(Date),
          sellerLastReadAt: expect.any(Date),
        }),
      });
    });

    it('refuses empty, long, blocked and too-fast messages', async () => {
      await expect(send(BUYER, '   ')).rejects.toThrow('vacío');
      await expect(send(BUYER, 'x'.repeat(2001))).rejects.toThrow('caracteres');

      prisma.conversation.findUnique.mockResolvedValueOnce(
        conversationRow({ status: 'BLOCKED' }),
      );
      await expect(send(BUYER, 'hola')).rejects.toThrow('bloqueada');

      prisma.conversationMessage.count.mockResolvedValueOnce(
        MESSAGES_PER_MINUTE,
      );
      await expect(send(BUYER, 'hola')).rejects.toThrow('muy rápido');
    });

    it('notifies the recipient once per unread burst (USR-13)', async () => {
      // Rate limit check, then "unread before this one".
      prisma.conversationMessage.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      await send(BUYER, 'hola');
      expect(users.notifyNewMessage).toHaveBeenCalledWith(SELLER, {
        conversationId: 7,
        senderId: BUYER,
        preview: 'hola',
        url: 'https://app.ekoru.cl/profile/messages?c=7',
      });

      users.notifyNewMessage.mockClear();
      prisma.conversationMessage.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);
      await send(BUYER, '¿sigue?');
      expect(users.notifyNewMessage).not.toHaveBeenCalled();
    });
  });

  it('marks read on the caller’s side only', async () => {
    await service.markRead({ conversationId: 7, viewerId: BUYER });

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { buyerLastReadAt: expect.any(Date) },
    });
  });

  it('lets only the participant who blocked unblock', async () => {
    prisma.conversation.findUnique.mockResolvedValueOnce(
      conversationRow({ status: 'BLOCKED', blockedById: SELLER }),
    );

    await expect(
      service.setBlocked({
        conversationId: 7,
        viewerId: BUYER,
        blocked: false,
      }),
    ).rejects.toThrow('Solo quien bloqueó');
  });

  it('refuses reporting your own message', async () => {
    prisma.conversationMessage.findUnique.mockResolvedValue({
      id: 99,
      conversationId: 7,
      senderId: BUYER,
    });

    await expect(
      service.reportMessage({ messageId: 99, viewerId: BUYER }),
    ).rejects.toThrow('propios mensajes');
  });

  it('pages messages newest first and reports when older ones remain', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue(
      [3, 2, 1].map((id) => ({
        id,
        conversationId: 7,
        senderId: id === 2 ? BUYER : SELLER,
        kind: 'TEXT',
        body: `m${id}`,
        masked: false,
        createdAt: new Date(),
      })),
    );

    const page = await service.conversationMessages({
      conversationId: 7,
      viewerId: BUYER,
      limit: 2,
    });

    expect(page.hasMore).toBe(true);
    expect(page.nodes.map((m) => [m.id, m.mine])).toEqual([
      [3, false],
      [2, true],
    ]);
  });
});
