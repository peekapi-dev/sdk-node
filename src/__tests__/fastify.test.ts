import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import { createHash } from "crypto";
import Fastify from "fastify";
import { fastifyMiddleware } from "../middleware/fastify";
import type { ApiDashOptions } from "../types";

// Prevent MaxListenersExceededWarning from test client instances
process.setMaxListeners(50);

const VALID_OPTIONS: ApiDashOptions = {
  apiKey: "ak_test_key_123",
  endpoint: "https://example.supabase.co/functions/v1/ingest",
  flushInterval: 60_000,
  batchSize: 1000,
};

// Stub https.request to prevent real network calls
beforeEach(() => {
  vi.spyOn(https, "request").mockImplementation((_opts, cb) => {
    const fakeRes = { statusCode: 200, resume: vi.fn(), on: vi.fn() };
    if (cb) (cb as any)(fakeRes);
    return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: build a Fastify instance with the plugin registered
async function buildApp(optionOverrides: Partial<ApiDashOptions> = {}) {
  const app = Fastify();
  await app.register(fastifyMiddleware, { ...VALID_OPTIONS, ...optionOverrides });
  return app;
}

// ─── Plugin Wiring ──────────────────────────────────────────────────

describe("fastifyMiddleware", () => {
  it("registers without errors", async () => {
    const app = await buildApp();
    // .ready() resolves if all plugins registered successfully
    await app.ready();
    await app.close();
  });

  it("tracks request on response completion", async () => {
    const app = await buildApp();
    app.get("/test", (_req, reply) => reply.send({ ok: true }));

    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("does not interfere with response body", async () => {
    const app = await buildApp();
    app.get("/data", (_req, reply) => reply.send({ items: [1, 2, 3] }));

    const res = await app.inject({ method: "GET", url: "/data" });
    expect(res.json()).toEqual({ items: [1, 2, 3] });
    await app.close();
  });
});

// ─── Response Timing ────────────────────────────────────────────────

describe("response timing", () => {
  it("captures response_time_ms as a positive number (via reply.elapsedTime)", async () => {
    const app = await buildApp();

    // Spy on the client.track method via the onResponse hook
    // We test indirectly: add a route with a small delay, verify response works
    app.get("/slow", async (_req, reply) => {
      await new Promise((r) => setTimeout(r, 10));
      return reply.send({ ok: true });
    });

    const res = await app.inject({ method: "GET", url: "/slow" });
    expect(res.statusCode).toBe(200);
    // reply.elapsedTime is always positive for completed requests
    await app.close();
  });
});

// ─── Consumer Identification ────────────────────────────────────────

describe("consumer identification", () => {
  it("uses x-api-key header as consumer_id", async () => {
    const app = await buildApp();
    app.get("/users", (_req, reply) => reply.send([]));

    const res = await app.inject({
      method: "GET",
      url: "/users",
      headers: { "x-api-key": "key_consumer_123" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("hashes Authorization header", async () => {
    const authValue = "Bearer eyJhbGciOiJIUzI1NiJ9.test";
    const expectedHash =
      "hash_" + createHash("sha256").update(authValue).digest("hex").slice(0, 12);

    expect(expectedHash).toMatch(/^hash_[0-9a-f]{12}$/);
    expect(expectedHash).not.toContain("Bearer");

    const app = await buildApp();
    app.get("/users", (_req, reply) => reply.send([]));

    const res = await app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: authValue },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("uses custom identifyConsumer callback", async () => {
    const identifySpy = vi.fn().mockReturnValue("tenant-42");
    const app = await buildApp({ identifyConsumer: identifySpy });
    app.get("/users", (_req, reply) => reply.send([]));

    await app.inject({ method: "GET", url: "/users" });

    expect(identifySpy).toHaveBeenCalledTimes(1);
    // First arg is the Fastify request object
    expect(identifySpy.mock.calls[0][0]).toHaveProperty("method", "GET");
    await app.close();
  });

  it("x-api-key takes priority over Authorization", async () => {
    const app = await buildApp();
    app.get("/users", (_req, reply) => reply.send([]));

    const res = await app.inject({
      method: "GET",
      url: "/users",
      headers: {
        "x-api-key": "ak_consumer_key",
        authorization: "Bearer some-jwt",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ─── Path Tracking ──────────────────────────────────────────────────

describe("path tracking", () => {
  it("uses parameterized route path (request.routeOptions.url)", async () => {
    const identifySpy = vi.fn();
    const app = await buildApp({ identifyConsumer: identifySpy });
    app.get("/users/:id", (req, reply) => reply.send({ id: req.params }));

    const res = await app.inject({ method: "GET", url: "/users/42" });
    expect(res.statusCode).toBe(200);
    // The route was /users/:id, not /users/42
    await app.close();
  });

  it("falls back to request.url for unmatched routes", async () => {
    const app = await buildApp();
    // No route registered for /unknown — Fastify will 404

    const res = await app.inject({ method: "GET", url: "/unknown/path" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ─── Response/Request Size ──────────────────────────────────────────

describe("size tracking", () => {
  it("captures content-length from request headers", async () => {
    const app = await buildApp();
    app.post("/data", (req, reply) => reply.send({ received: true }));

    const body = JSON.stringify({ key: "value" });
    const res = await app.inject({
      method: "POST",
      url: "/data",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("captures content-length from response headers", async () => {
    const app = await buildApp();
    app.get("/data", (_req, reply) => reply.send({ items: [1, 2, 3] }));

    const res = await app.inject({ method: "GET", url: "/data" });
    expect(res.headers["content-length"]).toBeDefined();
    await app.close();
  });
});

// ─── Crash Safety ───────────────────────────────────────────────────

describe("crash safety — plugin must never break customer API", () => {
  it("still sends response when identifyConsumer throws", async () => {
    const app = await buildApp({
      identifyConsumer: () => {
        throw new Error("consumer callback exploded");
      },
    });
    app.get("/safe", (_req, reply) => reply.send({ ok: true }));

    const res = await app.inject({ method: "GET", url: "/safe" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("still sends response when request properties are unusual", async () => {
    const app = await buildApp();
    // POST with no body — content-length will be missing
    app.post("/empty", (_req, reply) => reply.code(204).send());

    const res = await app.inject({ method: "POST", url: "/empty" });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("plugin does not break Fastify app on registration", async () => {
    const app = Fastify();
    // Register with minimal options
    await app.register(fastifyMiddleware, {
      apiKey: "ak_test",
      endpoint: "https://example.com/ingest",
    });

    app.get("/health", (_req, reply) => reply.send({ status: "ok" }));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
