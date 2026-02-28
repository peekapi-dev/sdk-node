import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PeekApiClient } from "../client";
import type { PeekApiOptions } from "../types";
import { defaultIdentifyConsumer, sortQueryString } from "./shared";

function peekapiPlugin(fastify: FastifyInstance, options: PeekApiOptions, done: () => void) {
  const client = new PeekApiClient(options);

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

        let path = request.routeOptions?.url ?? request.url;
        if (options.collectQueryString) {
          path += sortQueryString(request.url);
        }

        client.track({
          method: request.method,
          path,
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

export const fastifyMiddleware = fp(peekapiPlugin, {
  name: "peekapi",
  fastify: ">=4.0.0",
});
