import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import {
  ConversationItemType,
  ConversationMessageKind,
  ConversationRole,
  ConversationStatus,
} from '../../graphql/enums/index.js';
import {
  PageInfo,
  ProductRef,
  Seller,
  ServiceRef,
  StoreProductRef,
} from '../../common/entities/index.js';

@ObjectType()
export class ConversationMessage {
  @Field(() => Int)
  id: number;

  @Field(() => Int)
  conversationId: number;

  /** Null for SYSTEM messages. */
  @Field(() => ID, { nullable: true })
  senderId: string | null;

  @Field(() => ConversationMessageKind)
  kind: ConversationMessageKind;

  @Field()
  body: string;

  /** Contact details were hidden before saving (TRX-19). */
  @Field()
  masked: boolean;

  /** Sent by the caller. */
  @Field()
  mine: boolean;

  @Field(() => Date)
  createdAt: Date;
}

/** A thread between a buyer and a seller about one item (TRX-18). */
@ObjectType()
export class Conversation {
  @Field(() => Int)
  id: number;

  @Field(() => ConversationItemType)
  itemType: ConversationItemType;

  @Field(() => ProductRef, { nullable: true })
  product: ProductRef | null;

  @Field(() => StoreProductRef, { nullable: true })
  storeProduct: StoreProductRef | null;

  @Field(() => ServiceRef, { nullable: true })
  service: ServiceRef | null;

  @Field(() => Seller)
  buyer: Seller;

  @Field(() => Seller)
  seller: Seller;

  /** The other participant, from the caller's side. */
  @Field(() => Seller)
  counterpart: Seller;

  @Field(() => ConversationRole)
  myRole: ConversationRole;

  @Field(() => ConversationStatus)
  status: ConversationStatus;

  /** The caller blocked it, so only the caller can unblock it. */
  @Field()
  blockedByMe: boolean;

  /**
   * Contact details flow freely between these two: they have an accepted deal,
   * a paid order or a booking. Otherwise they are masked (TRX-19).
   */
  @Field()
  contactAllowed: boolean;

  @Field(() => Int)
  unreadCount: number;

  @Field(() => ConversationMessage, { nullable: true })
  lastMessage: ConversationMessage | null;

  @Field(() => Date)
  lastMessageAt: Date;

  @Field(() => Date)
  createdAt: Date;
}

@ObjectType()
export class ConversationConnection {
  @Field(() => [Conversation])
  nodes: Conversation[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}

/** Messages newest first; `hasMore` when older ones remain. */
@ObjectType()
export class ConversationMessagePage {
  @Field(() => [ConversationMessage])
  nodes: ConversationMessage[];

  @Field()
  hasMore: boolean;
}
