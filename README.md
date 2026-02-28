# PeekAPI — Node.js SDK

[![npm](https://img.shields.io/npm/v/@peekapi/sdk-node)](https://www.npmjs.com/package/@peekapi/sdk-node)
[![license](https://img.shields.io/npm/l/@peekapi/sdk-node)](./LICENSE)

Zero-dependency Node.js SDK for [PeekAPI](https://peekapi.dev). Add API analytics to any Node.js framework with one line of middleware.

## Install

```bash
npm install @peekapi/sdk-node
```

## Quick Start

### Express

```js
import express from "express";
import { peekapi } from "@peekapi/sdk-node";

const app = express();
app.use(peekapi({ apiKey: "ak_live_xxx" }));

app.get("/api/users", (req, res) => res.json({ users: [] }));
app.listen(3000);
```

### Fastify

```js
import Fastify from "fastify";
import { peekapiFastify } from "@peekapi/sdk-node";

const app = Fastify();
app.register(peekapiFastify, { apiKey: "ak_live_xxx" });

app.get("/api/users", async () => ({ users: [] }));
app.listen({ port: 3000 });
```

### Koa

```js
import Koa from "koa";
import { peekapiKoa } from "@peekapi/sdk-node";

const app = new Koa();
app.use(peekapiKoa({ apiKey: "ak_live_xxx" }));

app.use((ctx) => { ctx.body = { users: [] }; });
app.listen(3000);
```

### Hapi

```js
import Hapi from "@hapi/hapi";
import { peekapiHapi } from "@peekapi/sdk-node";

const server = Hapi.server({ port: 3000 });
await server.register({ plugin: peekapiHapi, options: { apiKey: "ak_live_xxx" } });

server.route({ method: "GET", path: "/api/users", handler: () => ({ users: [] }) });
await server.start();
```

### NestJS

```ts
import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { PeekApiInterceptor } from "@peekapi/sdk-node";

@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useFactory: () => new PeekApiInterceptor({ apiKey: "ak_live_xxx" }),
    },
  ],
})
export class AppModule {}
```

### Standalone Client

```js
import { PeekApiClient } from "@peekapi/sdk-node";

const client = new PeekApiClient({ apiKey: "ak_live_xxx" });

client.track({
  method: "GET",
  path: "/api/users",
  status_code: 200,
  response_time_ms: 42,
});

// Graceful shutdown (flushes remaining events)
client.shutdown();
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `apiKey` | required | Your PeekAPI key |
| `endpoint` | PeekAPI cloud | Ingestion endpoint URL |
| `flushInterval` | `10000` | Milliseconds between automatic flushes |
| `batchSize` | `100` | Events per HTTP POST (triggers flush) |
| `maxBufferSize` | `10000` | Max events held in memory |
| `maxStorageBytes` | `5242880` | Max disk fallback file size (5MB) |
| `maxEventBytes` | `65536` | Per-event size limit (64KB) |
| `storagePath` | auto | Custom path for JSONL persistence file |
| `debug` | `false` | Enable debug logging |
| `identifyConsumer` | auto | Custom consumer ID extraction function |
| `tlsOptions` | `undefined` | TLS options for https.Agent |
| `onError` | `undefined` | Callback for background flush errors |

## How It Works

1. Middleware intercepts every request/response
2. Captures method, path, status code, response time, request/response sizes, consumer ID
3. Events are buffered in memory and flushed in batches on a timer or when `batchSize` is reached
4. Flushes are async and non-blocking — <1ms overhead per request
5. On network failure: exponential backoff with jitter, up to 5 retries
6. After max retries: events are persisted to a JSONL file on disk
7. On next startup: persisted events are recovered and re-sent
8. On SIGTERM/SIGINT: remaining buffer is flushed or persisted to disk

## Consumer Identification

By default, consumers are identified by:

1. `X-API-Key` header — stored as-is
2. `Authorization` header — hashed with SHA-256 (stored as `hash_<hex>`)

Override with the `identifyConsumer` option to use any header or request property:

```js
app.use(peekapi({
  apiKey: "ak_live_xxx",
  identifyConsumer: (req) => req.headers["x-tenant-id"],
}));
```

## What Gets Tracked

| Field | Description |
|---|---|
| `method` | HTTP method (GET, POST, etc.) |
| `path` | Route path (no query strings) |
| `status_code` | Response status code |
| `response_time_ms` | Time to respond in ms |
| `request_size` | Request body size in bytes |
| `response_size` | Response body size in bytes |
| `consumer_id` | API consumer identifier |
| `timestamp` | ISO 8601 timestamp |

## Requirements

- Node.js >= 18

## License

MIT
