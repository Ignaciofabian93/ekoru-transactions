import { Args, Field, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import {
  OrderStatus as DbOrderStatus,
  P2PStatus as DbP2PStatus,
  PaymentStatus as DbPaymentStatus,
  PaymentType as DbPaymentType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CurrentAdmin } from '../common/decorators/index.js';
import { assertAdminCan } from '../common/admin-access.js';
import {
  calculatePrismaParams,
  createPaginatedResponse,
} from '../common/utils/index.js';
import { PageInfo } from '../common/entities/index.js';
import { OrdersService } from '../orders/orders.service.js';
import { OrderConnection } from '../orders/entities/index.js';
import { PaymentsService } from '../payments/payments.service.js';
import {
  PaymentConnection,
  PaymentRefund,
} from '../payments/entities/index.js';
import { P2PDeal } from '../marketplace-deals/entities/index.js';
import {
  AdminDealsArgs,
  AdminOrdersArgs,
  AdminPaymentsArgs,
} from './admin-operations.args.js';

@ObjectType()
export class P2PDealConnection {
  @Field(() => [P2PDeal])
  nodes: P2PDeal[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;
}

/** Orders and deals: the panel's orders and exchanges screens. */
const ORDER_READERS = ['MANAGE_ORDERS', 'VIEW_TRANSACTIONS'] as const;
/** Payments: finance, refunds, and order handling. */
const PAYMENT_READERS = [
  'VIEW_TRANSACTIONS',
  'PROCESS_REFUNDS',
  'MANAGE_ORDERS',
] as const;

const createdBetween = (from?: Date, to?: Date) =>
  from || to
    ? { createdAt: { ...(from && { gte: from }), ...(to && { lt: to }) } }
    : {};

/** No seller has this id: an email that matches nobody returns no rows. */
const NOBODY = '__no_seller__';

/**
 * Operator lists for the admin panel (TRX-11): orders, payments with their
 * refunds, and P2P deals, filterable and paginated. Detail views use the
 * existing `getOrder`, `getPayment` and `deal`, which already let these
 * admins through; refunds use `refundPayment`; disputes `resolveDeal`.
 */
@Resolver()
export class AdminOperationsResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * The seller id behind an email, for the "find by email" filter. Seller
   * belongs to ekoru-users, so it is read with raw SQL.
   */
  private async sellerIdByEmail(email?: string): Promise<string | undefined> {
    const value = email?.trim();
    if (!value) return undefined;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Seller" WHERE lower("email") = lower(${value}) LIMIT 1`;
    return rows[0]?.id ?? NOBODY;
  }

  @Query(() => OrderConnection, {
    name: 'adminOrders',
    description:
      'Orders across the platform. Platform admins with MANAGE_ORDERS or VIEW_TRANSACTIONS.',
  })
  async adminOrders(
    @Args() args: AdminOrdersArgs,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, ORDER_READERS);
    const party = await this.sellerIdByEmail(args.email);
    const where: Prisma.OrderWhereInput = {
      ...(party && { OR: [{ buyerId: party }, { sellerId: party }] }),
      ...(args.orderId != null && { id: args.orderId }),
      ...(args.status && { status: args.status as unknown as DbOrderStatus }),
      ...(args.sellerId && { sellerId: args.sellerId }),
      ...(args.buyerId && { buyerId: args.buyerId }),
      ...createdBetween(args.from, args.to),
    };
    return this.orders.listOrders({
      where,
      page: args.page,
      pageSize: args.pageSize,
    });
  }

  @Query(() => PaymentConnection, {
    name: 'adminPayments',
    description:
      'Payments across the platform. Platform admins with VIEW_TRANSACTIONS, PROCESS_REFUNDS or MANAGE_ORDERS.',
  })
  async adminPayments(
    @Args() args: AdminPaymentsArgs,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, PAYMENT_READERS);
    const party = await this.sellerIdByEmail(args.email);
    const where: Prisma.PaymentWhereInput = {
      ...(party && { OR: [{ payerId: party }, { receiverId: party }] }),
      ...(args.status && {
        status: args.status as unknown as DbPaymentStatus,
      }),
      ...(args.paymentType && {
        paymentType: args.paymentType as unknown as DbPaymentType,
      }),
      ...(args.payerId && { payerId: args.payerId }),
      ...(args.receiverId && { receiverId: args.receiverId }),
      ...(args.orderId != null && { orderId: args.orderId }),
      ...(args.quotationId != null && { quotationId: args.quotationId }),
      ...(args.externalId && { externalId: args.externalId }),
      ...createdBetween(args.from, args.to),
    };
    return this.payments.listPayments({
      where,
      page: args.page,
      pageSize: args.pageSize,
    });
  }

  @Query(() => [PaymentRefund], {
    name: 'adminPaymentRefunds',
    description:
      "A payment's refunds, newest first. Same admins as adminPayments.",
  })
  async adminPaymentRefunds(
    @Args('paymentId', { type: () => Int }) paymentId: number,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, PAYMENT_READERS);
    return this.payments.listRefunds(paymentId);
  }

  @Query(() => P2PDealConnection, {
    name: 'adminDeals',
    description:
      'P2P deals across the platform, disputes included. Platform admins with MANAGE_ORDERS or VIEW_TRANSACTIONS.',
  })
  async adminDeals(
    @Args() args: AdminDealsArgs,
    @CurrentAdmin() adminId?: string,
  ) {
    await assertAdminCan(this.prisma, adminId, ORDER_READERS);
    const party = await this.sellerIdByEmail(args.email);
    const where: Prisma.P2PDealWhereInput = {
      ...(party && { OR: [{ buyerId: party }, { sellerId: party }] }),
      ...(args.status && { status: args.status as unknown as DbP2PStatus }),
      ...(args.sellerId && { sellerId: args.sellerId }),
      ...(args.buyerId && { buyerId: args.buyerId }),
      ...createdBetween(args.from, args.to),
    };
    const { skip, take } = calculatePrismaParams(args.page, args.pageSize);
    const [count, deals] = await Promise.all([
      this.prisma.p2PDeal.count({ where }),
      this.prisma.p2PDeal.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return createPaginatedResponse(deals, count, args.page, args.pageSize);
  }
}
