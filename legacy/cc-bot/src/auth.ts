import type { Context, MiddlewareFn } from "grammy";

export function ownerOnly(ownerId: number): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (ctx.from?.id !== ownerId) {
      console.warn(
        `rejected update from non-owner id=${ctx.from?.id} username=${ctx.from?.username}`,
      );
      return;
    }
    await next();
  };
}
