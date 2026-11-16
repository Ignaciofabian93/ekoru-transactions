import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { GqlArgumentsHost, GqlExceptionFilter } from '@nestjs/graphql';
import { GraphQLError, type GraphQLResolveInfo } from 'graphql';
import type { RequestIdentity } from '../identity.js';

/**
 * One clear line for each error a resolver raises on purpose (the same filter
 * as ekoru-users).
 *
 * Nest logs every thrown error that isn't one of its own HTTP exceptions as
 * ERROR with a stack trace, so a refused session or a missing listing looked
 * like a crash and didn't say which field or who was asking. Errors we raise
 * ourselves (GraphQLError and its subclasses) are logged here with the field,
 * the code and the caller: INTERNAL_SERVER_ERROR as an error with its stack,
 * anything else as a warning. Any other exception isn't caught here and keeps
 * Nest's full log.
 *
 * The response is unchanged: the gateway decides what the person sees.
 */
@Catch(GraphQLError)
export class GraphQLErrorLogFilter implements GqlExceptionFilter {
  private readonly logger = new Logger('GraphQLErrors');

  catch(exception: GraphQLError, host: ArgumentsHost) {
    const gql = GqlArgumentsHost.create(host);
    const info = gql.getInfo<GraphQLResolveInfo | undefined>();
    const field = info
      ? `${info.parentType.name}.${info.fieldName}`
      : 'unknown field';
    const code =
      typeof exception.extensions?.code === 'string'
        ? exception.extensions.code
        : 'UNKNOWN';
    const line = `${code} ${field}: "${exception.message}" | ${caller(
      gql.getContext<CallerContext | undefined>(),
    )}`;

    if (code === 'INTERNAL_SERVER_ERROR')
      this.logger.error(line, exception.stack);
    else this.logger.warn(line);

    // Returned, not thrown: GraphQL turns it into the response error as before.
    return exception;
  }
}

type CallerContext = RequestIdentity & {
  internalSecret?: string;
  req?: { headers?: Record<string, unknown> };
};

function caller(ctx: CallerContext | undefined): string {
  if (ctx?.sellerId) return `seller ${ctx.sellerId}`;
  if (ctx?.adminId) return `admin ${ctx.adminId}`;
  if (ctx?.internalSecret || ctx?.req?.headers?.['x-internal-secret']) {
    return 'internal call';
  }
  return 'no access token received (the gateway log says why)';
}
