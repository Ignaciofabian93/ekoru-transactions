import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { GraphQLResolveInfo, OperationTypeNode } from 'graphql';
import { Observable } from 'rxjs';

/**
 * The most rows one query may ask for (GW-6). Lists passed `pageSize` straight
 * to the database, so one call could ask for every row of a table. 500 is the
 * largest size any client uses: the panel's exports read 500 rows a page.
 */
export const MAX_LIST_SIZE = 500;

/** The argument names that say how many rows a list returns. */
const SIZE_KEYS = new Set(['pageSize', 'limit', 'take', 'first']);

/** Arguments, their input objects, and one level more. */
const MAX_DEPTH = 3;

/**
 * Lowers every list size above the cap, in place. Lower values, and every
 * other argument, are left as they came.
 */
export function capListSizes(args: unknown, depth = 0): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const record = args as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number') {
      if (SIZE_KEYS.has(key) && value > MAX_LIST_SIZE) {
        record[key] = MAX_LIST_SIZE;
      }
    } else if (depth < MAX_DEPTH) {
      capListSizes(value, depth + 1);
    }
  }
}

/**
 * Caps the list sizes of every query in one place, before validation and the
 * resolver read the arguments. Mutations are left alone: there a field called
 * `limit` may be a value to store, not a page size.
 */
@Injectable()
export class ListSizeCapInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<GqlContextType>() === 'graphql') {
      const gql = GqlExecutionContext.create(context);
      const info = gql.getInfo<GraphQLResolveInfo | undefined>();
      if (info?.operation?.operation === OperationTypeNode.QUERY) {
        capListSizes(gql.getArgs());
      }
    }
    return next.handle();
  }
}
