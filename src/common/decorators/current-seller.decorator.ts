import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

// The GraphQL context (see app.module.ts) exposes sellerId/adminId at the top
// level — sourced from the x-seller-id / x-admin-id headers the gateway sets —
// NOT on `req`. Read them from the context object, matching the other subgraphs.
export const CurrentSeller = createParamDecorator(
  (data: unknown, context: ExecutionContext): string | undefined => {
    const ctx = GqlExecutionContext.create(context);
    return ctx.getContext().sellerId;
  },
);

export const CurrentAdmin = createParamDecorator(
  (data: unknown, context: ExecutionContext): string | undefined => {
    const ctx = GqlExecutionContext.create(context);
    return ctx.getContext().adminId;
  },
);
