import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import { createHash } from "crypto";
import Koa from "koa";
import request from "supertest";
import { koaMiddleware } from "../middleware/koa";
import type { PeekApiOptions } from "../types";

// Prevent MaxListenersExceededWarning from test client instances
process.setMaxListeners(50);

const VALID_OPTIONS: PeekApiOptions = {
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

function buildApp(optionOverrides: Partial<PeekApiOptions> = {}) {
  const app = new Koa();
  app.use(koaMiddleware({ ...VALID_OPTIONS, ...optionOverrides }));
  return app;
}

// ─── Middleware Wiring ──────────────────────────────────────────────

describe("koaMiddleware", () => {
  it("registers without errors", async () => {
    const app = buildApp();
    app.use((ctx) => {
      ctx.body = { ok: true };
    });
    const res = await request(app.callback()).get("/test");
    expect(res.status).toBe(200);
  });

  it("does not interfere with response body", async () => {
    const app = buildApp();
    app.use((ctx) => {
      ctx.body = { items: [1, 2, 3] };
    });
    const res = await request(app.callback()).get("/data");
    expect(res.body).toEqual({ items: [1, 2, 3] });
  });

  it("tracks request with correct status code", async () => {
    const app = buildApp();
    app.use((ctx) => {
      ctx.status = 201;
      ctx.body = { created: true };
    });
    const res = await request(app.callback()).get("/create");
    expect(res.status).toBe(201);
  });
});

// ─── Consumer Identification ────────────────────────────────────────

describe("consumer identification", () => {
  it("uses x-api-key header as consumer_id", async () => {
    const app = buildApp();
    app.use((ctx) => {
      ctx.body = [];
    });
    const res = await request(app.callback()).get("/users").set("x-api-key", "key_consumer_123");
    expect(res.status).toBe(200);
  });

  it("hashes Authorization header", async () => {
    const authValue = "Bearer eyJhbGciOiJIUzI1NiJ9.test";
    const expectedHash =
      "hash_" + createHash("sha256").update(authValue).digest("hex").slice(0, 12);

    expect(expectedHash).toMatch(/^hash_[0-9a-f]{12}$/);
    expect(expectedHash).not.toContain("Bearer");

    const app = buildApp();
    app.use((ctx) => {
      ctx.body = [];
    });
    const res = await request(app.callback()).get("/users").set("authorization", authValue);
    expect(res.status).toBe(200);
  });

  it("uses custom identifyConsumer callback", async () => {
    const identifySpy = vi.fn().mockReturnValue("tenant-42");
    const app = buildApp({ identifyConsumer: identifySpy });
    app.use((ctx) => {
      ctx.body = [];
    });
    await request(app.callback()).get("/users");
    expect(identifySpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Crash Safety ───────────────────────────────────────────────────

describe("crash safety — middleware must never break customer API", () => {
  it("still sends response when identifyConsumer throws", async () => {
    const app = buildApp({
      identifyConsumer: () => {
        throw new Error("consumer callback exploded");
      },
    });
    app.use((ctx) => {
      ctx.body = { ok: true };
    });
    const res = await request(app.callback()).get("/safe");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("handles missing body gracefully", async () => {
    const app = buildApp();
    app.use((ctx) => {
      ctx.status = 204;
    });
    const res = await request(app.callback()).post("/empty");
    expect(res.status).toBe(204);
  });
});

// ─── collectQueryString ──────────────────────────────────────────────

describe("collectQueryString option", () => {
  it("does not throw when collectQueryString is true", async () => {
    const app = buildApp({ collectQueryString: true });
    app.use((ctx) => {
      ctx.body = { results: [] };
    });

    const res = await request(app.callback()).get("/search?z=3&a=1");
    expect(res.status).toBe(200);
  });

  it("handles request without query string when enabled", async () => {
    const app = buildApp({ collectQueryString: true });
    app.use((ctx) => {
      ctx.body = [];
    });

    const res = await request(app.callback()).get("/users");
    expect(res.status).toBe(200);
  });
});
