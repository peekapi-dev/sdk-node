import type { Plugin, Request, ResponseToolkit, Server } from "@hapi/hapi";
import { ApiDashClient } from "../client";
import type { ApiDashOptions } from "../types";
import { defaultIdentifyConsumer } from "./shared";

export const hapiPlugin: Plugin<ApiDashOptions> = {
  name: "apidash",
  version: "1.0.0",
  register(server: Server, options: ApiDashOptions) {
    const client = new ApiDashClient(options);

    // Flush remaining events when the server stops
    server.ext("onPreStop", async () => client.shutdown());

    server.ext("onPreResponse", (request: Request, h: ResponseToolkit) => {
      try {
        const consumerId = options.identifyConsumer
          ? options.identifyConsumer(request.raw.req)
          : defaultIdentifyConsumer(request.headers);

        const info = request.info;
        const duration = info.responded ? info.responded - info.received : 0;

        const response = request.response;
        const statusCode =
          response && "isBoom" in response && response.isBoom
            ? response.output.statusCode
            : ((response as any)?.statusCode ?? 0);

        client.track({
          method: request.method.toUpperCase(),
          path: request.route.path,
          status_code: statusCode,
          response_time_ms: Math.round(duration * 100) / 100,
          request_size: Number(request.headers["content-length"] ?? 0),
          response_size: Number((response as any)?.headers?.["content-length"] ?? 0),
          consumer_id: consumerId,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Analytics must never break the customer's API
      }

      return h.continue;
    });
  },
};
