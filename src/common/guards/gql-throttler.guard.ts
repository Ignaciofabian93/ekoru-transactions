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
 *
 * Every request reaches this subgraph from the gateway, so `req.ip` is the
 * gateway container for all visitors. The gateway forwards the visitor's own
 * address in `x-client-ip` (always overwriting any client-supplied value), and
 * that is what we count against (GW-4). Subgraph ports are not published, so
 * the header can only come from the gateway.
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

  protected getTracker(req: Record<string, any>): Promise<string> {
    const headers = (req.headers ?? {}) as Record<string, unknown>;
    const forwarded = headers['x-client-ip'];
    const clientIp =
      typeof forwarded === 'string' && forwarded.trim() ? forwarded.trim() : '';
    return Promise.resolve(clientIp || (req.ip as string) || 'unknown');
  }
}
