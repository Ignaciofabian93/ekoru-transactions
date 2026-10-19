import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { getNamedType, GraphQLResolveInfo, isObjectType } from 'graphql';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/** This subgraph's name, stored in each row's metadata. */
const SUBGRAPH = 'transactions';

const OWN_ACTIVITY_LOG = 'adminActivity:own';

/**
 * Marks an admin mutation that writes its own, richer AdminActivityLog row,
 * so AdminActivityInterceptor does not add a second one.
 */
export const LogsOwnActivity = () => SetMetadata(OWN_ACTIVITY_LOG, true);

const MAX_STRING = 300;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;
const MAX_JSON = 8000;
// `oauth` covers the one-time OAuth code and state of a Mercado Pago connection.
const SECRET_KEY = /password|token|secret|oauth/i;

/** Arguments trimmed for the log: long strings cut, big lists counted, secrets hidden. */
function summarize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '…';
  if (Array.isArray(value)) {
    return value.length > MAX_ITEMS
      ? { count: value.length }
      : value.map((item) => summarize(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '[redacted]' : summarize(item, depth + 1),
      ]),
    );
  }
  return null;
}

function idOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/** The first top-level `somethingId` argument, e.g. refundPayment(paymentId). */
function firstIdArgument(args: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(args)) {
    if (
      /Id$/.test(key) &&
      (typeof value === 'string' || typeof value === 'number')
    ) {
      return String(value);
    }
  }
  return null;
}

/**
 * What one admin mutation did, as an AdminActivityLog row: the field name in
 * SCREAMING_SNAKE (refundPayment → REFUND_PAYMENT), the entity it returned or
 * was given, and its arguments without `language`.
 */
export function describeActivity(
  info: Pick<GraphQLResolveInfo, 'fieldName' | 'returnType'>,
  args: Record<string, unknown>,
  result: unknown,
) {
  const named = getNamedType(info.returnType);
  const returnsObject = isObjectType(named);
  const rest = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== 'language'),
  );
  const summary = Object.keys(rest).length ? summarize(rest) : null;
  const json = summary === null ? null : JSON.stringify(summary);

  return {
    action: info.fieldName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase(),
    entityType: returnsObject ? named.name : null,
    entityId:
      (returnsObject ? idOf(result) : null) ??
      idOf(args) ??
      idOf(args.input) ??
      firstIdArgument(args),
    changes:
      json && json.length > MAX_JSON
        ? JSON.stringify({ truncated: true, arguments: Object.keys(rest) })
        : json,
  };
}

interface ActivityContext {
  adminId?: string;
  req?: { headers?: Record<string, unknown> };
}

/**
 * Records every admin mutation in AdminActivityLog (USR-12), the table the
 * panel's activity screen reads (ADM-7). It runs on each Mutation field that
 * succeeds with an admin caller, so a new admin mutation is covered without
 * extra code. The table belongs to ekoru-users and every subgraph shares the
 * database, so the row is written with raw SQL. A failed write is logged and
 * never fails the mutation.
 */
@Injectable()
export class AdminActivityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminActivityInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<GqlContextType>() !== 'graphql') return next.handle();
    const gql = GqlExecutionContext.create(context);
    const info = gql.getInfo<GraphQLResolveInfo>();
    const { adminId, req } = gql.getContext<ActivityContext>() ?? {};
    if (
      info?.parentType?.name !== 'Mutation' ||
      !adminId ||
      this.reflector.get<boolean>(OWN_ACTIVITY_LOG, context.getHandler())
    ) {
      return next.handle();
    }
    const args = gql.getArgs<Record<string, unknown>>() ?? {};
    const header = req?.headers?.['x-client-ip'];
    const ipAddress =
      typeof header === 'string' && header.trim() ? header.trim() : null;

    return next.handle().pipe(
      tap((result: unknown) => {
        void this.record({
          adminId,
          ipAddress,
          ...describeActivity(info, args, result),
        });
      }),
    );
  }

  private async record(row: {
    adminId: string;
    ipAddress: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    changes: string | null;
  }): Promise<void> {
    try {
      const metadata = JSON.stringify({ subgraph: SUBGRAPH });
      await this.prisma.$executeRaw`
        INSERT INTO "AdminActivityLog"
          ("adminId", "action", "entityType", "entityId", "changes", "ipAddress", "metadata", "updatedAt")
        VALUES (${row.adminId}, ${row.action}, ${row.entityType}, ${row.entityId},
                ${row.changes}::jsonb, ${row.ipAddress}, ${metadata}::jsonb, NOW())
      `;
    } catch (error) {
      this.logger.error(
        `Could not record ${row.action} by admin ${row.adminId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
