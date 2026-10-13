import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import {
  ConversationItemType,
  ConversationStatus,
} from '../../graphql/enums/index.js';
import {
  PageInfo,
  ProductRef,
  Seller,
  ServiceRef,
  StoreProductRef,
} from '../../common/entities/index.js';

/** A conversation as an operator sees it: both sides, no "me" (ADM-14). */
@ObjectType()
export class AdminConversation {
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

  @Field(() => ConversationStatus)
  status: ConversationStatus;

  /** An operator blocked it, so neither participant can unblock it. */
  @Field()
  blockedByAdmin: boolean;
}

@ObjectType()
export class ReportedMessage {
  /** The message id. */
  @Field(() => Int)
  id: number;

  @Field()
  body: string;

  @Field()
  masked: boolean;

  @Field(() => ID, { nullable: true })
  senderId: string | null;

  @Field(() => Seller, { nullable: true })
  sender: Seller | null;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  reportedAt: Date;

  @Field(() => String, { nullable: true })
  reportReason: string | null;

  @Field(() => Seller, { nullable: true })
  reporter: Seller | null;

  @Field(() => Date, { nullable: true })
  resolvedAt: Date | null;

  @Field(() => AdminConversation)
  conversation: AdminConversation;
}

@ObjectType()
export class ReportedMessageConnection {
  @Field(() => [ReportedMessage])
  nodes: ReportedMessage[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}
