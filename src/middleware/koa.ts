import type { Context, Next, Middleware } from "koa";
import { ApiDashClient } from "../client";
import type { ApiDashOptions } from "../types";
import { defaultIdentifyConsumer } from "./shared";

export function koaMiddleware(options: ApiDashOptions): Middleware {
  const client = new ApiDashClient(options);

  process.once("beforeExit", () => client.shutdown());

  return async function apiDashMiddleware(ctx: Context, next: Next): Promise<void> {
    const start = process.hrtime.bigint();

    await next();

    try {
      const duration = Number(process.hrtime.bigint() - start) / 1e6;

      const consumerId = options.identifyConsumer
        ? options.identifyConsumer(ctx.req)
        : defaultIdentifyConsumer(ctx.headers);

      client.track({
        method: ctx.method,
        path: ctx.routePath ?? ctx.path,
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
