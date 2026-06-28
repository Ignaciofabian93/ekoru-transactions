import { ObjectType, Field, Float, Int } from '@nestjs/graphql';

@ObjectType()
export class RevenueStats {
  /** Sum of `amount` for COMPLETED payments */
  @Field(() => Float)
  totalRevenue: number;

  /** Sum of `netAmount` for COMPLETED payments */
  @Field(() => Float)
  totalNetRevenue: number;

  /** Sum of `fees` for COMPLETED payments */
  @Field(() => Float)
  totalFees: number;

  /** Count of COMPLETED payments */
  @Field(() => Int)
  completedCount: number;

  /** Sum of `amount` for PENDING payments */
  @Field(() => Float)
  pendingRevenue: number;

  /** Count of PENDING payments */
  @Field(() => Int)
  pendingCount: number;
}

@ObjectType()
export class MonthlyRevenue {
  /** ISO month string e.g. "2025-01" */
  @Field(() => String)
  month: string;

  @Field(() => Float)
  revenue: number;

  @Field(() => Float)
  netRevenue: number;

  @Field(() => Int)
  count: number;
}
