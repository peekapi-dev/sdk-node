import type { Request, Response, NextFunction } from "express";
import { ApiDashClient } from "../client";
import type { ApiDashOptions } from "../types";
import { defaultIdentifyConsumer } from "./shared";

export function expressMiddleware(options: ApiDashOptions) {
  const client = new ApiDashClient(options);

  // Flush on process exit (once to avoid listener leak)
  process.once("beforeExit", () => client.shutdown());

  return function apiDashMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startTime = process.hrtime.bigint();
    const socketBytesAtStart = req.socket?.bytesRead ?? 0;

    // Accumulate response size across res.write() and res.end()
    const originalWrite = res.write;
    const originalEnd = res.end;
    let responseSize = 0;

    function addChunkSize(chunk: unknown): void {
      if (chunk) {
        responseSize +=
          typeof chunk === "string"
            ? Buffer.byteLength(chunk)
            : Buffer.isBuffer(chunk)
              ? chunk.length
              : 0;
      }
    }

    res.write = function (this: Response, ...args: any[]): boolean {
      addChunkSize(args[0]);
      return originalWrite.apply(this, args as any);
    } as any;

    res.end = function (this: Response, ...args: any[]): Response {
      // Track the request, but never let analytics errors break the response.
      // The originalEnd.apply() call MUST execute regardless of tracking success.
      try {
        addChunkSize(args[0]);

        const duration = Number(process.hrtime.bigint() - startTime) / 1e6;

        // Request size: prefer socket bytes differential, fall back to content-length
        const socketBytesRead = req.socket?.bytesRead ?? 0;
        const requestSize =
          socketBytesRead > socketBytesAtStart
            ? socketBytesRead - socketBytesAtStart
            : Number(req.headers["content-length"] ?? 0);

        // Determine consumer ID
        const consumerId = options.identifyConsumer
          ? options.identifyConsumer(req)
          : defaultIdentifyConsumer(req.headers);

        client.track({
          method: req.method,
          path: req.route?.path ? (req.baseUrl ?? "") + req.route.path : req.path,
          status_code: res.statusCode,
          response_time_ms: Math.round(duration * 100) / 100,
          request_size: requestSize,
          response_size: responseSize,
          consumer_id: consumerId,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Swallow — analytics must never break the customer's API
      }

      return originalEnd.apply(this, args as any);
    } as any;

    next();
  };
}
