import { Resolver, Query, Mutation, Args, Int } from '@nestjs/graphql';
import { ChatAdminService } from './chat-admin.service.js';
import {
  AdminConversation,
  ReportedMessageConnection,
} from './entities/reported-message.entity.js';
import { ConversationMessagePage } from './entities/conversation.entity.js';
import { CurrentAdmin } from '../common/decorators/index.js';

/** Chat moderation for the admin panel (ADM-14). MODERATE_CONTENT. */
@Resolver()
export class ChatAdminResolver {
  constructor(private readonly chatAdmin: ChatAdminService) {}

  @Query(() => ReportedMessageConnection, {
    description:
      'Reported chat messages, newest first; open reports only by default.',
  })
  reportedMessages(
    @CurrentAdmin() adminId: string | undefined,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 20 }) pageSize: number,
    @Args('includeResolved', { defaultValue: false }) includeResolved: boolean,
  ) {
    return this.chatAdmin.reportedMessages({
      adminId,
      page,
      pageSize: Math.min(Math.max(pageSize, 1), 100),
      includeResolved,
    });
  }

  @Query(() => ConversationMessagePage, {
    description: 'Any conversation, for reviewing a report. Newest first.',
  })
  adminConversationMessages(
    @CurrentAdmin() adminId: string | undefined,
    @Args('conversationId', { type: () => Int }) conversationId: number,
    @Args('before', { type: () => Int, nullable: true }) before?: number,
  ) {
    return this.chatAdmin.conversationMessages({
      adminId,
      conversationId,
      before,
    });
  }

  @Mutation(() => Boolean, {
    description: 'Marks a report reviewed; the message stays.',
  })
  resolveMessageReport(
    @CurrentAdmin() adminId: string | undefined,
    @Args('messageId', { type: () => Int }) messageId: number,
  ) {
    return this.chatAdmin.resolveReport({ adminId, messageId });
  }

  @Mutation(() => AdminConversation, {
    description:
      'Blocks a conversation for both sides; only an operator can unblock it.',
  })
  adminBlockConversation(
    @CurrentAdmin() adminId: string | undefined,
    @Args('conversationId', { type: () => Int }) conversationId: number,
  ) {
    return this.chatAdmin.setBlocked({
      adminId,
      conversationId,
      blocked: true,
    });
  }

  @Mutation(() => AdminConversation)
  adminUnblockConversation(
    @CurrentAdmin() adminId: string | undefined,
    @Args('conversationId', { type: () => Int }) conversationId: number,
  ) {
    return this.chatAdmin.setBlocked({
      adminId,
      conversationId,
      blocked: false,
    });
  }
}
