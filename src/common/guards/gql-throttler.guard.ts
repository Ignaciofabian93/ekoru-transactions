import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limiting for the transactions subgraph.
 *
 * Every other subgraph has had this; transactions — the one that moves money —
 * did not, so payment, order and refund mutations had no per-caller ceiling of
 * any kind.
 *
 * Mirrors the guard in the other subgraphs: Apollo Federation does not always
 * populate `ctx.res`, but Express hangs the response off the request.
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  getRequestResponse(context: ExecutionContext) {
    const gqlCtx = GqlExecutionContext.create(context);
    const ctx = gqlCtx.getContext();
    if (ctx?.req) {
      return { req: ctx.req, res: ctx.res ?? ctx.req.res };
    }
    const http = context.switchToHttp();
    return { req: http.getRequest(), res: http.getResponse() };
  }
}
