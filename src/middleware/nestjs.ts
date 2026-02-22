import { tap } from "rxjs";
import { ApiDashClient } from "../client";
import type { ApiDashOptions } from "../types";
import { defaultIdentifyConsumer } from "./shared";

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

let sharedClient: ApiDashClient | undefined;

export class ApiDashInterceptor {
  private client: ApiDashClient;
  private options: ApiDashOptions;

  constructor(options: ApiDashOptions) {
    // Reuse a single client instance across interceptor instances
    if (!sharedClient) {
      sharedClient = new ApiDashClient(options);
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

          this.client.track({
            method: request.method,
            path: request.route?.path ?? request.url,
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
