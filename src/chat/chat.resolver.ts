import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { ChatService, type ConversationRecord } from './chat.service.js';
import {
  Conversation,
  ConversationConnection,
  ConversationMessage,
  ConversationMessagePage,
} from './entities/conversation.entity.js';
import { ConversationItemType } from '../graphql/enums/index.js';
import { requireSeller } from '../common/admin-access.js';
import { CurrentSeller } from '../common/decorators/index.js';

/** Chat between buyers and sellers (TRX-18). Every operation needs a signed-in seller. */
@Resolver(() => Conversation)
export class ChatResolver {
  constructor(private readonly chat: ChatService) {}

  @Mutation(() => Conversation, {
    description:
      'Opens the thread about an item, or returns the existing one. The item owner ' +
      'passes `counterpartId` to open it from a deal, order or booking with that person. ' +
      'An optional first message is sent with it.',
  })
  startConversation(
    @CurrentSeller() sellerId: string | undefined,
    @Args('itemType', { type: () => ConversationItemType })
    itemType: ConversationItemType,
    @Args('itemId', { type: () => Int }) itemId: number,
    @Args('counterpartId', { type: () => ID, nullable: true })
    counterpartId?: string,
    @Args('message', { nullable: true }) message?: string,
  ) {
    return this.chat.startConversation({
      callerId: requireSeller(sellerId),
      itemType,
      itemId,
      counterpartId,
      message,
    });
  }

  @Mutation(() => ConversationMessage, {
    description:
      'Contact details are masked until the two have a deal, order or booking (TRX-19).',
  })
  sendMessage(
    @CurrentSeller() sellerId: string | undefined,
    @Args('conversationId', { type: () => Int }) conversationId: number,
    @Args('body') body: string,
  ) {
    return this.chat.sendMessage({
      conversationId,
      senderId: requireSeller(sellerId),
      body,
    });
  }

  @Mutation(() => Boolean)
  markConversationRead(
    @CurrentSeller() sellerId: string | undefined,
    @Args('conversationId', { type: () => Int }) conversationId: number,
  ) {
    return this.chat.markRead({
      conversationId,
      viewerId: requireSeller(sellerId),
    });
  }

  @Mutation(() => Boolean, {
    description: 'Flags a message for EKORU to review.',
  })
  reportMessage(
    @CurrentSeller() sellerId: string | undefined,
    @Args('messageId', { type: () => Int }) messageId: number,
    @Args('reason', { nullable: true }) reason?: string,
  ) {
    return this.chat.reportMessage({
      messageId,
      viewerId: requireSeller(sellerId),
      reason,
    });
  }

  @Mutation(() => Conversation, {
    description: 'Stops new messages both ways.',
  })
  blockConversation(
    @CurrentSeller() sellerId: string | undefined,
    @Args('conversationId', { type: () => Int }) conversationId: number,
  ) {
    return this.chat.setBlocked({
      conversationId,
      viewerId: requireSeller(sellerId),
      blocked: true,
    });
  }

  @Mutation(() => Conversation, {
    description: 'Only the participant who blocked can unblock.',
  })
  unblockConversation(
    @CurrentSeller() sellerId: string | undefined,
    @Args('conversationId', { type: () => Int }) conversationId: number,
  ) {
    return this.chat.setBlocked({
      conversationId,
      viewerId: requireSeller(sellerId),
      blocked: false,
    });
  }

  @Query(() => ConversationConnection, {
    description: "The caller's conversations, most recent first.",
  })
  myConversations(
    @CurrentSeller() sellerId: string | undefined,
    @Args('page', { type: () => Int, defaultValue: 1 }) page: number,
    @Args('pageSize', { type: () => Int, defaultValue: 20 }) pageSize: number,
  ) {
    return this.chat.myConversations({
      viewerId: requireSeller(sellerId),
      page,
      pageSize: Math.min(Math.max(pageSize, 1), 50),
    });
  }

  @Query(() => Conversation)
  conversation(
    @CurrentSeller() sellerId: string | undefined,
    @Args('id', { type: () => Int }) id: number,
  ) {
    return this.chat.getConversation({
      conversationId: id,
      viewerId: requireSeller(sellerId),
    });
  }

  @Query(() => ConversationMessagePage, {
    description:
      'Newest first. `before` pages back through history; `after` returns only what ' +
      'arrived since the last poll.',
  })
  conversationMessages(
    @CurrentSeller() sellerId: string | undefined,
    @Args('conversationId', { type: () => Int }) conversationId: number,
    @Args('before', { type: () => Int, nullable: true }) before?: number,
    @Args('after', { type: () => Int, nullable: true }) after?: number,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ) {
    return this.chat.conversationMessages({
      conversationId,
      viewerId: requireSeller(sellerId),
      before,
      after,
      limit: limit ?? undefined,
    });
  }

  @Query(() => Int, {
    description:
      'Conversations with unread messages, for the badge. 0 when signed out.',
  })
  myUnreadConversationCount(@CurrentSeller() sellerId: string | undefined) {
    return sellerId ? this.chat.unreadConversationCount(sellerId) : 0;
  }

  @ResolveField(() => Boolean)
  contactAllowed(@Parent() conversation: ConversationRecord) {
    return this.chat.contactAllowed(conversation);
  }
}
