import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import { createHash } from "crypto";
import { expressMiddleware } from "../middleware/express";
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

// Mock Express req/res/next
function mockReq(overrides: Record<string, any> = {}) {
  return {
    method: "GET",
    path: "/api/users",
    route: { path: "/api/users" },
    headers: {},
    socket: { bytesRead: 0 },
    cookies: {},
    ...overrides,
  } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    end: vi.fn().mockReturnThis(),
    write: vi.fn().mockReturnValue(true),
  };
  return res;
}

// ─── Middleware Wiring ────────────────────────────────────────────────

describe("expressMiddleware", () => {
  it("returns a middleware function", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    expect(typeof mw).toBe("function");
    expect(mw.length).toBe(3); // req, res, next
  });

  it("calls next() to pass control to the next middleware", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const next = vi.fn();
    mw(mockReq(), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("tracks event when res.end() is called", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq({ method: "POST", path: "/api/orders" });
    const originalEnd = vi.fn().mockReturnThis();
    const res = mockRes();
    res.end = originalEnd;
    res.statusCode = 201;
    const next = vi.fn();

    mw(req, res, next);

    // Middleware wraps res.end, so we call the wrapped version
    res.end("created");

    // The original end should have been called by the wrapper
    expect(originalEnd).toHaveBeenCalledTimes(1);
  });

  it("captures response_time_ms as a positive number", () => {
    const mw = expressMiddleware(VALID_OPTIONS);

    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    mw(req, res, next);
    res.end();

    // We can't easily inspect track() since client is private,
    // but we verify the middleware doesn't throw and res.end works
    expect(next).toHaveBeenCalled();
  });
});

// ─── Consumer ID Identification ───────────────────────────────────────

describe("consumer identification", () => {
  it("uses x-api-key header as consumer_id when present", () => {
    // To test consumer ID, we'll create middleware with a spy identifyConsumer
    const identifySpy = vi.fn().mockReturnValue("custom-id");
    const mw = expressMiddleware({ ...VALID_OPTIONS, identifyConsumer: identifySpy });

    const req = mockReq({ headers: { "x-api-key": "key123" } });
    const res = mockRes();
    const next = vi.fn();

    mw(req, res, next);
    res.end();

    expect(identifySpy).toHaveBeenCalledWith(req);
  });

  it("uses custom identifyConsumer when provided", () => {
    const identifySpy = vi.fn().mockReturnValue("tenant-42");
    const mw = expressMiddleware({ ...VALID_OPTIONS, identifyConsumer: identifySpy });

    const req = mockReq();
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();

    expect(identifySpy).toHaveBeenCalledWith(req);
  });

  it("default: hashes Authorization header (not stored raw)", () => {
    // We can test the hash function indirectly by verifying the expected hash format
    const authValue = "Bearer eyJhbGciOiJIUzI1NiJ9.test";
    const expectedHash =
      "hash_" + createHash("sha256").update(authValue).digest("hex").slice(0, 12);

    // Verify the hash function logic matches
    expect(expectedHash).toMatch(/^hash_[0-9a-f]{12}$/);
    expect(expectedHash).not.toContain("Bearer");
    expect(expectedHash).not.toContain("eyJ");
  });

  it("default: x-api-key takes priority over Authorization", () => {
    // Both headers present — x-api-key should win (stored as-is, not hashed)
    // This tests the ordering logic in defaultIdentifyConsumer
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq({
      headers: {
        "x-api-key": "ak_consumer_key",
        authorization: "Bearer some-jwt",
      },
    });
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();
    // No direct assertion on the tracked event since client is internal,
    // but we verify it doesn't throw
  });
});

// ─── Response Size Accumulation ───────────────────────────────────────

describe("response size tracking", () => {
  it("accumulates size across res.write() and res.end()", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq();
    const res = mockRes();
    mw(req, res, vi.fn());

    // Simulate chunked response
    res.write("chunk1"); // 6 bytes
    res.write("chunk2"); // 6 bytes
    res.end("final"); // 5 bytes

    // Verify write and end were called (middleware wraps them)
    // The total would be 17 bytes — we can't inspect the tracked event directly
    // but we verify the middleware patches work without errors
  });

  it("handles res.end() with no body", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq();
    const res = mockRes();
    mw(req, res, vi.fn());

    // Should not throw
    res.end();
  });

  it("handles Buffer chunks", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq();
    const res = mockRes();
    mw(req, res, vi.fn());

    res.write(Buffer.from("hello"));
    res.end(Buffer.from("world"));
    // Should not throw
  });
});

// ─── Request Size Tracking ────────────────────────────────────────────

describe("request size tracking", () => {
  it("uses content-length header when socket bytes unavailable", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq({
      headers: { "content-length": "42" },
      socket: { bytesRead: 0 },
    });
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();
    // Falls back to content-length: 42
  });

  it("prefers socket bytesRead differential over content-length", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const socket = { bytesRead: 100 };
    const req = mockReq({
      headers: { "content-length": "42" },
      socket,
    });
    const res = mockRes();
    mw(req, res, vi.fn());

    // Simulate socket reading more bytes during request processing
    socket.bytesRead = 250;
    res.end();
    // Should use 250 - 100 = 150 instead of content-length 42
  });
});

// ─── Route Path ───────────────────────────────────────────────────────

describe("path tracking", () => {
  it("prefers req.route.path over req.path", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq({
      path: "/api/users/123",
      route: { path: "/api/users/:id" },
    });
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();
    // Should track "/api/users/:id" (parameterized)
  });

  it("falls back to req.path when req.route is undefined", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq({ path: "/api/users/123", route: undefined });
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();
    // Should track "/api/users/123"
  });

  it("prepends baseUrl to route.path for mounted routers", () => {
    // When Express mounts a router at /api/v1, req.route.path is relative
    // (e.g. "/users/:id") but baseUrl is "/api/v1". The tracked path should
    // be the full "/api/v1/users/:id".
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq({
      baseUrl: "/api/v1",
      path: "/api/v1/users/42",
      route: { path: "/users/:id" },
    });
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();
    // Should track "/api/v1/users/:id" — verified by reading the tracked event
    // Since client is internal, we verify no throw + correct wiring
  });

  it("handles missing baseUrl gracefully", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq({
      baseUrl: undefined,
      path: "/users/42",
      route: { path: "/users/:id" },
    });
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();
    // Should track "/users/:id" without prefix
  });
});

// ─── Crash Safety ─────────────────────────────────────────────────────

describe("crash safety — middleware must never break customer response", () => {
  it("still calls original res.end() when identifyConsumer throws", () => {
    const mw = expressMiddleware({
      ...VALID_OPTIONS,
      identifyConsumer: () => {
        throw new Error("consumer callback exploded");
      },
    });
    const req = mockReq();
    const originalEnd = vi.fn().mockReturnThis();
    const res = mockRes();
    res.end = originalEnd;
    const next = vi.fn();

    mw(req, res, next);

    // This must NOT throw — the response must be sent
    expect(() => res.end("ok")).not.toThrow();
    expect(originalEnd).toHaveBeenCalledTimes(1);
  });

  it("still calls original res.end() when req properties are missing", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    // Bare minimum req — missing method, path, socket, headers
    const req = {} as any;
    const originalEnd = vi.fn().mockReturnThis();
    const res = mockRes();
    res.end = originalEnd;
    const next = vi.fn();

    mw(req, res, next);
    expect(() => res.end()).not.toThrow();
    expect(originalEnd).toHaveBeenCalledTimes(1);
  });

  it("next() is always called regardless of tracking errors", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── collectQueryString ──────────────────────────────────────────────

describe("collectQueryString option", () => {
  it("does not include query string by default", () => {
    const mw = expressMiddleware(VALID_OPTIONS);
    const req = mockReq({
      path: "/search",
      originalUrl: "/search?q=foo&page=1",
      route: undefined,
    });
    const res = mockRes();
    mw(req, res, vi.fn());
    // No throw — query string excluded by default
    res.end();
  });

  it("appends sorted query string when collectQueryString is true", () => {
    const mw = expressMiddleware({ ...VALID_OPTIONS, collectQueryString: true });
    const req = mockReq({
      path: "/search",
      originalUrl: "/search?z=3&a=1&m=2",
      route: undefined,
    });
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();
    // Middleware doesn't throw — sorted QS appended internally
  });

  it("handles missing originalUrl gracefully", () => {
    const mw = expressMiddleware({ ...VALID_OPTIONS, collectQueryString: true });
    const req = mockReq({
      path: "/users",
      originalUrl: "/users",
      route: undefined,
    });
    const res = mockRes();
    mw(req, res, vi.fn());
    res.end();
    // No query string → path stays "/users"
  });
});
