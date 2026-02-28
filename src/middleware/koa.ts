import type { Context, Next, Middleware } from "koa";
import { PeekApiClient } from "../client";
import type { PeekApiOptions } from "../types";
import { defaultIdentifyConsumer, sortQueryString } from "./shared";

export function koaMiddleware(options: PeekApiOptions): Middleware {
  const client = new PeekApiClient(options);

  process.once("beforeExit", () => client.shutdown());

  return async function peekapiMiddleware(ctx: Context, next: Next): Promise<void> {
    const start = process.hrtime.bigint();

    await next();

    try {
      const duration = Number(process.hrtime.bigint() - start) / 1e6;

      const consumerId = options.identifyConsumer
        ? options.identifyConsumer(ctx.req)
        : defaultIdentifyConsumer(ctx.headers);

      let path = ctx.routePath ?? ctx.path;
      if (options.collectQueryString) {
        path += sortQueryString(ctx.originalUrl ?? ctx.url);
      }

      client.track({
        method: ctx.method,
        path,
        status_code: ctx.status,
        response_time_ms: Math.round(duration * 100) / 100,
        request_size: ctx.request.length ?? 0,
        response_size: ctx.response.length ?? 0,
        consumer_id: consumerId,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Analytics must never break the customer's API
    }
  };
}
