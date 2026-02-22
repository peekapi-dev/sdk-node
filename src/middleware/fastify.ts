import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiDashClient } from "../client";
import type { ApiDashOptions } from "../types";
import { defaultIdentifyConsumer } from "./shared";

function apiDashPlugin(fastify: FastifyInstance, options: ApiDashOptions, done: () => void) {
  const client = new ApiDashClient(options);

  // Flush remaining events when Fastify shuts down
  fastify.addHook("onClose", async () => client.shutdown());

  // Track every request after the response has been sent
  fastify.addHook(
    "onResponse",
    (request: FastifyRequest, reply: FastifyReply, hookDone: () => void) => {
      try {
        const consumerId = options.identifyConsumer
          ? options.identifyConsumer(request)
          : defaultIdentifyConsumer(request.headers);

        client.track({
          method: request.method,
          path: request.routeOptions?.url ?? request.url,
          status_code: reply.statusCode,
          response_time_ms: Math.round(reply.elapsedTime * 100) / 100,
          request_size: Number(request.headers["content-length"] ?? 0),
          response_size: Number(reply.getHeader("content-length") ?? 0),
          consumer_id: consumerId,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Analytics must never break the customer's API
      }
      hookDone();
    },
  );

  done();
}

export const fastifyMiddleware = fp(apiDashPlugin, {
  name: "apidash",
  fastify: ">=4.0.0",
});
