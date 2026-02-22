import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import { createHash } from "crypto";
import Hapi from "@hapi/hapi";
import Boom from "@hapi/boom";
import { hapiPlugin } from "../middleware/hapi";
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

async function buildServer(optionOverrides: Partial<ApiDashOptions> = {}) {
  const server = Hapi.server({ port: 0 });
  await server.register({
    plugin: hapiPlugin,
    options: { ...VALID_OPTIONS, ...optionOverrides },
  });
  return server;
}

// ─── Plugin Wiring ──────────────────────────────────────────────────

describe("hapiPlugin", () => {
  it("registers without errors", async () => {
    const server = await buildServer();
    server.route({ method: "GET", path: "/test", handler: () => ({ ok: true }) });
    await server.initialize();
    await server.stop();
  });

  it("tracks request on response completion", async () => {
    const server = await buildServer();
    server.route({ method: "GET", path: "/test", handler: () => ({ ok: true }) });

    const res = await server.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    await server.stop();
  });

  it("does not interfere with response body", async () => {
    const server = await buildServer();
    server.route({
      method: "GET",
      path: "/data",
      handler: () => ({ items: [1, 2, 3] }),
    });

    const res = await server.inject({ method: "GET", url: "/data" });
    expect(JSON.parse(res.payload)).toEqual({ items: [1, 2, 3] });
    await server.stop();
  });
});

// ─── Consumer Identification ────────────────────────────────────────

describe("consumer identification", () => {
  it("uses x-api-key header as consumer_id", async () => {
    const server = await buildServer();
    server.route({ method: "GET", path: "/users", handler: () => [] });

    const res = await server.inject({
      method: "GET",
      url: "/users",
      headers: { "x-api-key": "key_consumer_123" },
    });
    expect(res.statusCode).toBe(200);
    await server.stop();
  });

  it("hashes Authorization header", async () => {
    const authValue = "Bearer eyJhbGciOiJIUzI1NiJ9.test";
    const expectedHash =
      "hash_" + createHash("sha256").update(authValue).digest("hex").slice(0, 12);

    expect(expectedHash).toMatch(/^hash_[0-9a-f]{12}$/);
    expect(expectedHash).not.toContain("Bearer");

    const server = await buildServer();
    server.route({ method: "GET", path: "/users", handler: () => [] });

    const res = await server.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: authValue },
    });
    expect(res.statusCode).toBe(200);
    await server.stop();
  });

  it("uses custom identifyConsumer callback", async () => {
    const identifySpy = vi.fn().mockReturnValue("tenant-42");
    const server = await buildServer({ identifyConsumer: identifySpy });
    server.route({ method: "GET", path: "/users", handler: () => [] });

    await server.inject({ method: "GET", url: "/users" });

    expect(identifySpy).toHaveBeenCalledTimes(1);
    await server.stop();
  });
});

// ─── Path Tracking ──────────────────────────────────────────────────

describe("path tracking", () => {
  it("uses parameterized route path", async () => {
    const server = await buildServer();
    server.route({
      method: "GET",
      path: "/users/{id}",
      handler: (request) => ({ id: request.params.id }),
    });

    const res = await server.inject({ method: "GET", url: "/users/42" });
    expect(res.statusCode).toBe(200);
    await server.stop();
  });

  it("handles 404 for unmatched routes", async () => {
    const server = await buildServer();
    const res = await server.inject({ method: "GET", url: "/unknown/path" });
    expect(res.statusCode).toBe(404);
    await server.stop();
  });
});

// ─── Error Handling ────────────────────────────────────────────────

describe("error responses", () => {
  it("tracks Boom error status codes correctly", async () => {
    const server = await buildServer();
    server.route({
      method: "GET",
      path: "/error",
      handler: () => {
        throw Boom.badRequest("invalid input");
      },
    });

    const res = await server.inject({ method: "GET", url: "/error" });
    expect(res.statusCode).toBe(400);
    await server.stop();
  });
});

// ─── Crash Safety ───────────────────────────────────────────────────

describe("crash safety — plugin must never break customer API", () => {
  it("still sends response when identifyConsumer throws", async () => {
    const server = await buildServer({
      identifyConsumer: () => {
        throw new Error("consumer callback exploded");
      },
    });
    server.route({ method: "GET", path: "/safe", handler: () => ({ ok: true }) });

    const res = await server.inject({ method: "GET", url: "/safe" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    await server.stop();
  });

  it("plugin does not break Hapi server on registration", async () => {
    const server = Hapi.server({ port: 0 });
    await server.register({
      plugin: hapiPlugin,
      options: { apiKey: "ak_test", endpoint: "https://example.com/ingest" },
    });

    server.route({ method: "GET", path: "/health", handler: () => ({ status: "ok" }) });
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: "ok" });
    await server.stop();
  });
});
