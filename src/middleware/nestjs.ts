import { tap } from "rxjs";
import { PeekApiClient } from "../client";
import type { PeekApiOptions } from "../types";
import { defaultIdentifyConsumer, sortQueryString } from "./shared";

/**
 * NestJS interceptor interfaces — inlined to avoid requiring @nestjs/common
 * as a dependency. These match the minimal contract NestJS expects.
 */
interface ExecutionContext {
  switchToHttp(): { getRequest(): any; getResponse(): any };
}

interface CallHandler {
  handle(): import("rxjs").Observable<any>;
}

let sharedClient: PeekApiClient | undefined;

export class PeekApiInterceptor {
  private client: PeekApiClient;
  private options: PeekApiOptions;

  constructor(options: PeekApiOptions) {
    // Reuse a single client instance across interceptor instances
    if (!sharedClient) {
      sharedClient = new PeekApiClient(options);
      process.once("beforeExit", () => sharedClient?.shutdown());
    }
    this.client = sharedClient;
    this.options = options;
  }

  intercept(context: ExecutionContext, next: CallHandler) {
    const start = process.hrtime.bigint();
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    return next.handle().pipe(
      tap(() => {
        try {
          const duration = Number(process.hrtime.bigint() - start) / 1e6;

          const consumerId = this.options.identifyConsumer
            ? this.options.identifyConsumer(request)
            : defaultIdentifyConsumer(request.headers ?? {});

          let path = request.route?.path ?? request.url;
          if (this.options.collectQueryString) {
            path += sortQueryString(request.originalUrl ?? request.url);
          }

          this.client.track({
            method: request.method,
            path,
            status_code: response.statusCode,
            response_time_ms: Math.round(duration * 100) / 100,
            request_size: Number(request.headers?.["content-length"] ?? 0),
            response_size: Number(response.getHeader?.("content-length") ?? 0),
            consumer_id: consumerId,
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Analytics must never break the customer's API
        }
      }),
    );
  }
}
