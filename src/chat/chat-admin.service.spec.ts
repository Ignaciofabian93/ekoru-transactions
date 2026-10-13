import { ConfigService } from '@nestjs/config';
import { ChatAdminService, ADMIN_BLOCK_PREFIX } from './chat-admin.service.js';
import { ChatService } from './chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersClient } from '../common/clients/users.client.js';

const conversation = (over: Record<string, unknown> = {}) => ({
  id: 7,
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  itemType: 'SERVICE',
  productId: null,
  storeProductId: null,
  serviceId: 3,
  status: 'OPEN',
  blockedById: null,
  ...over,
});

describe('ChatAdminService (ADM-14)', () => {
  const moderator = {
    adminType: 'PLATFORM',
    role: 'MODERATOR',
    permissions: ['MODERATE_CONTENT'],
    isActive: true,
  };
  const prisma = {
    // assertAdminCan reads the Admin table with raw SQL.
    $queryRaw: jest.fn(),
    conversation: { findUnique: jest.fn(), update: jest.fn() },
    conversationMessage: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new ChatAdminService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([moderator]);
    prisma.conversation.findUnique.mockResolvedValue(conversation());
  });

  it('needs MODERATE_CONTENT', async () => {
    prisma.$queryRaw.mockResolvedValue([{ ...moderator, permissions: [] }]);

    await expect(
      service.reportedMessages({ adminId: 'a1' }),
    ).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    await expect(service.reportedMessages({})).rejects.toThrow();
  });

  it('lists open reports with both sides of the thread', async () => {
    prisma.conversationMessage.count.mockResolvedValue(1);
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        id: 99,
        body: 'insulto',
        masked: false,
        senderId: 'seller-1',
        createdAt: new Date(),
        reportedAt: new Date(),
        reportedById: 'buyer-1',
        reportReason: 'ofensivo',
        reportResolvedAt: null,
        conversation: conversation(),
      },
    ]);

    const result = await service.reportedMessages({ adminId: 'a1' });

    expect(prisma.conversationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reportedAt: { not: null }, reportResolvedAt: null },
      }),
    );
    expect(result.nodes[0]).toMatchObject({
      id: 99,
      sender: { id: 'seller-1' },
      reporter: { id: 'buyer-1' },
      conversation: { buyer: { id: 'buyer-1' }, service: { id: 3 } },
    });
  });

  it('blocks as an operator, which a participant cannot undo', async () => {
    prisma.conversation.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(conversation(data)),
    );

    const blocked = await service.setBlocked({
      adminId: 'a1',
      conversationId: 7,
      blocked: true,
    });
    expect(blocked).toMatchObject({ status: 'BLOCKED', blockedByAdmin: true });

    // The participant's own unblock refuses an operator's block.
    prisma.conversation.findUnique.mockResolvedValue(
      conversation({
        status: 'BLOCKED',
        blockedById: `${ADMIN_BLOCK_PREFIX}a1`,
      }),
    );
    const chat = new ChatService(
      prisma as unknown as PrismaService,
      {} as UsersClient,
      { get: () => '' } as unknown as ConfigService,
    );
    await expect(
      chat.setBlocked({
        conversationId: 7,
        viewerId: 'buyer-1',
        blocked: false,
      }),
    ).rejects.toThrow('Solo quien bloqueó');
  });

  it('resolves a report and keeps the message', async () => {
    prisma.conversationMessage.findUnique.mockResolvedValue({ id: 99 });

    await expect(
      service.resolveReport({ adminId: 'a1', messageId: 99 }),
    ).resolves.toBe(true);
    expect(prisma.conversationMessage.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { reportResolvedAt: expect.any(Date) },
    });
  });
});
