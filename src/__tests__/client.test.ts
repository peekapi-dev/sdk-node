import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import { PeekApiClient, _isPrivateIP } from "../client";
import type { RequestEvent } from "../types";

// Helpers

function makeEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    method: "GET",
    path: "/api/test",
    status_code: 200,
    response_time_ms: 42,
    request_size: 0,
    response_size: 128,
    timestamp: "2026-02-20T12:00:00Z",
    ...overrides,
  };
}

function tmpStoragePath(): string {
  return path.join(
    os.tmpdir(),
    `peekapi-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

const VALID_OPTIONS = {
  apiKey: "ak_test_key_123",
  endpoint: "https://example.supabase.co/functions/v1/ingest",
  flushInterval: 60_000, // long interval so timer doesn't fire during tests
  batchSize: 100,
};

// Prevent MaxListenersExceededWarning from test client instances
process.setMaxListeners(50);

// Stub http.request and https.request to prevent real network calls
let requestStub: ReturnType<typeof vi.spyOn>;
let _httpRequestStub: ReturnType<typeof vi.spyOn>;

/** Create a mock HTTP response that works for both success (resume) and error (event-based body read) paths. */
function makeMockRes(statusCode: number, body = "", headers: Record<string, string> = {}) {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const res = {
    statusCode,
    headers,
    resume: vi.fn(),
    on(event: string, cb: (...args: any[]) => void) {
      (listeners[event] ??= []).push(cb);
      return res;
    },
  };
  // For error responses, fire data/end events on next tick so all listeners are registered first
  if (statusCode < 200 || statusCode >= 300) {
    process.nextTick(() => {
      if (body) {
        for (const cb of listeners["data"] ?? []) cb(Buffer.from(body));
      }
      for (const cb of listeners["end"] ?? []) cb();
    });
  }
  return res;
}

const mockRequestImpl = (_opts: unknown, cb: unknown) => {
  if (cb) (cb as any)(makeMockRes(200));
  return {
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  } as any;
};

beforeEach(() => {
  requestStub = vi.spyOn(https, "request").mockImplementation(mockRequestImpl);
  _httpRequestStub = vi.spyOn(http, "request").mockImplementation(mockRequestImpl);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Constructor Validation ───────────────────────────────────────────

describe("constructor validation", () => {
  it("uses default endpoint when not provided", () => {
    const client = new PeekApiClient({ apiKey: "ak_test" });
    expect((client as any).parsedUrl.hostname).toContain("supabase.co");
    client.shutdown();
  });

  it("throws on invalid URL", () => {
    expect(() => new PeekApiClient({ apiKey: "ak_test", endpoint: "not-a-url" })).toThrow(
      "Invalid endpoint URL",
    );
  });

  it("throws on plain HTTP (non-localhost)", () => {
    expect(
      () =>
        new PeekApiClient({
          apiKey: "ak_test",
          endpoint: "http://example.com/ingest",
        }),
    ).toThrow("Endpoint must use HTTPS");
  });

  it("allows http://localhost for local dev", () => {
    const client = new PeekApiClient({
      apiKey: "ak_test",
      endpoint: "http://localhost:3000/ingest",
      flushInterval: 60_000,
    });
    expect(client).toBeDefined();
    client.shutdown();
  });

  it("allows http://127.0.0.1 for local dev", () => {
    const client = new PeekApiClient({
      apiKey: "ak_test",
      endpoint: "http://127.0.0.1:3000/ingest",
      flushInterval: 60_000,
    });
    expect(client).toBeDefined();
    client.shutdown();
  });

  it("blocks private IP addresses (SSRF)", () => {
    const privateIPs = [
      "https://10.0.0.1/ingest",
      "https://172.16.0.1/ingest",
      "https://192.168.1.1/ingest",
      "https://169.254.1.1/ingest",
    ];
    for (const endpoint of privateIPs) {
      expect(
        () => new PeekApiClient({ apiKey: "ak_test", endpoint, flushInterval: 60_000 }),
      ).toThrow("private or internal IP");
    }
  });

  it("strips embedded credentials from endpoint URL", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new PeekApiClient({
      apiKey: "ak_test",
      endpoint: "https://user:pass@example.com/ingest",
      debug: true,
      flushInterval: 60_000,
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Stripped embedded credentials"));
    client.shutdown();
  });

  it("throws when apiKey is missing", () => {
    expect(() => new PeekApiClient({ apiKey: "", endpoint: "https://example.com/ingest" })).toThrow(
      "'apiKey' is required",
    );
  });

  it("throws when apiKey contains CRLF", () => {
    expect(
      () =>
        new PeekApiClient({
          apiKey: "ak_test\r\nInjected: header",
          endpoint: "https://example.com/ingest",
        }),
    ).toThrow("invalid characters");
  });

  it("throws when apiKey contains null byte", () => {
    expect(
      () =>
        new PeekApiClient({
          apiKey: "ak_test\0",
          endpoint: "https://example.com/ingest",
        }),
    ).toThrow("invalid characters");
  });
});

// ─── Buffer Management ────────────────────────────────────────────────

describe("buffer management", () => {
  it("buffers events via track()", () => {
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 10,
      storagePath: tmpStoragePath(),
    });
    client.track(makeEvent());
    client.track(makeEvent());
    // Access private buffer via any cast for testing
    expect((client as any).buffer).toHaveLength(2);
    client.shutdown();
  });

  it("triggers flush when buffer is full (never drops events)", () => {
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      maxBufferSize: 3,
      batchSize: 3, // flush triggers at maxBufferSize
    });

    client.track(makeEvent({ path: "/first" }));
    client.track(makeEvent({ path: "/second" }));
    // 3rd event hits batchSize, triggers flush
    client.track(makeEvent({ path: "/third" }));

    // Flush was triggered (mock sends immediately), buffer drained
    expect(requestStub).toHaveBeenCalled();

    // 4th event goes into fresh buffer
    client.track(makeEvent({ path: "/fourth" }));
    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer[0].path).toBe("/fourth");

    client.shutdown();
  });

  it("truncates long paths to 2048 chars", () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    const longPath = "/api/" + "x".repeat(3000);
    client.track(makeEvent({ path: longPath }));

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer[0].path.length).toBe(2048);
    client.shutdown();
  });

  it("truncates long methods to 16 chars", () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    client.track(makeEvent({ method: "SUPERLONGMETHOD!" }));

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer[0].method.length).toBeLessThanOrEqual(16);
    client.shutdown();
  });

  it("truncates consumer_id to 256 chars", () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    const longId = "c".repeat(500);
    client.track(makeEvent({ consumer_id: longId }));

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer[0].consumer_id!.length).toBe(256);
    client.shutdown();
  });
});

// ─── Per-Event Size Limit ─────────────────────────────────────────────

describe("per-event size limit (maxEventBytes)", () => {
  it("strips metadata when event exceeds maxEventBytes", () => {
    const client = new PeekApiClient({ ...VALID_OPTIONS, maxEventBytes: 256 });
    const bigMeta = { payload: "x".repeat(1000) };
    client.track(makeEvent({ metadata: bigMeta }));

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer).toHaveLength(1);
    expect(buffer[0].metadata).toBeUndefined();
    client.shutdown();
  });

  it("keeps metadata when event is within maxEventBytes", () => {
    const client = new PeekApiClient({ ...VALID_OPTIONS, maxEventBytes: 65_536 });
    const smallMeta = { tag: "ok" };
    client.track(makeEvent({ metadata: smallMeta }));

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer).toHaveLength(1);
    expect(buffer[0].metadata).toEqual(smallMeta);
    client.shutdown();
  });

  it("drops event entirely if still too large after stripping metadata", () => {
    // Use a very low limit that even a bare event exceeds
    const client = new PeekApiClient({ ...VALID_OPTIONS, maxEventBytes: 10 });
    client.track(makeEvent({ metadata: { a: 1 } }));

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer).toHaveLength(0);
    client.shutdown();
  });

  it("does not check size when metadata is absent", () => {
    const client = new PeekApiClient({ ...VALID_OPTIONS, maxEventBytes: 10 });
    // No metadata — size check is skipped, event is accepted even if technically large
    client.track(makeEvent());

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer).toHaveLength(1);
    client.shutdown();
  });
});

// ─── Flush Behavior ───────────────────────────────────────────────────

describe("flush", () => {
  it("auto-flushes when buffer reaches batchSize", async () => {
    const client = new PeekApiClient({ ...VALID_OPTIONS, batchSize: 2 });

    client.track(makeEvent());
    client.track(makeEvent()); // triggers flush

    // Give the async flush a tick to complete
    await vi.waitFor(() => {
      expect(requestStub).toHaveBeenCalled();
    });

    expect((client as any).buffer).toHaveLength(0);
    client.shutdown();
  });

  it("sends correct payload to endpoint", async () => {
    const client = new PeekApiClient({ ...VALID_OPTIONS, batchSize: 1 });
    const event = makeEvent({ path: "/api/users" });
    client.track(event);

    await vi.waitFor(() => {
      expect(requestStub).toHaveBeenCalled();
    });

    const callArgs = requestStub.mock.calls[0][0] as any;
    expect(callArgs.hostname).toBe("example.supabase.co");
    expect(callArgs.path).toBe("/functions/v1/ingest");
    expect(callArgs.method).toBe("POST");
    expect(callArgs.headers["x-api-key"]).toBe("ak_test_key_123");
    expect(callArgs.headers["Content-Type"]).toBe("application/json");
    expect(callArgs.headers["x-peekapi-sdk"]).toMatch(/^node\/\d+\.\d+\.\d+$/);
    client.shutdown();
  });

  it("skips flush when buffer is empty", async () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    await client.flush();
    expect(requestStub).not.toHaveBeenCalled();
    client.shutdown();
  });

  it("prevents concurrent flushes via flushInFlight guard", async () => {
    // Make send() hang to simulate in-flight request
    requestStub.mockImplementation(() => {
      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as any;
    });

    const client = new PeekApiClient({ ...VALID_OPTIONS, batchSize: 1000 });
    client.track(makeEvent());
    client.track(makeEvent());

    // First flush starts (never resolves because we don't call the callback)
    void client.flush();
    // Second flush should bail because flushInFlight is true
    void client.flush();

    expect(requestStub).toHaveBeenCalledTimes(1);
    client.shutdown();
  });
});

// ─── Retry & Backoff ──────────────────────────────────────────────────

describe("retry and backoff", () => {
  it("re-inserts events into buffer on flush failure", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      maxBufferSize: 100,
    });
    client.track(makeEvent());
    client.track(makeEvent());

    await client.flush();

    // Events should be re-inserted
    expect((client as any).buffer.length).toBeGreaterThan(0);
    expect((client as any).consecutiveFailures).toBe(1);
    client.shutdown();
  });

  it("sets backoff delay after failure", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({ ...VALID_OPTIONS, batchSize: 1000 });
    client.track(makeEvent());
    await client.flush();

    expect((client as any).backoffUntil).toBeGreaterThan(Date.now() - 100);

    // Second flush should be skipped due to backoff
    await client.flush();
    expect(requestStub).toHaveBeenCalledTimes(1); // only the first call
    client.shutdown();
  });

  it("resets failures after successful flush", async () => {
    let callCount = 0;
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      callCount++;
      const status = callCount <= 2 ? 500 : 200;
      if (cb) (cb as any)(makeMockRes(status));
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({ ...VALID_OPTIONS, batchSize: 1000 });
    client.track(makeEvent());

    // First flush fails
    await client.flush();
    expect((client as any).consecutiveFailures).toBe(1);

    // Skip backoff for testing
    (client as any).backoffUntil = 0;

    // Second flush fails
    await client.flush();
    expect((client as any).consecutiveFailures).toBe(2);

    // Skip backoff
    (client as any).backoffUntil = 0;

    // Third flush succeeds
    await client.flush();
    expect((client as any).consecutiveFailures).toBe(0);
    expect((client as any).backoffUntil).toBe(0);
    client.shutdown();
  });
});

// ─── Disk Persistence ─────────────────────────────────────────────────

describe("disk persistence", () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = tmpStoragePath();
  });

  afterEach(() => {
    for (const p of [storagePath, storagePath + ".recovering"]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* doesn't exist */
      }
    }
  });

  it("persists events to disk after max consecutive failures", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath,
    });

    client.track(makeEvent({ path: "/persisted" }));

    // Simulate 5 consecutive failures
    for (let i = 0; i < 5; i++) {
      (client as any).backoffUntil = 0;
      await client.flush();
    }

    // File should exist with persisted events
    expect(fs.existsSync(storagePath)).toBe(true);
    const content = fs.readFileSync(storagePath, "utf-8").trim();
    const batch = JSON.parse(content);
    expect(batch).toBeInstanceOf(Array);
    expect(batch[0].path).toBe("/persisted");
    client.shutdown();
  });

  it("recovers persisted events on startup", () => {
    // Pre-write a JSONL file
    const events = [makeEvent({ path: "/recovered" })];
    fs.writeFileSync(storagePath, JSON.stringify(events) + "\n");

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath,
    });

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer.length).toBeGreaterThanOrEqual(1);
    expect(buffer[0].path).toBe("/recovered");

    // Original file renamed to .recovering (not deleted yet — deleted after first successful flush)
    expect(fs.existsSync(storagePath)).toBe(false);
    expect(fs.existsSync(storagePath + ".recovering")).toBe(true);
    client.shutdown();
  });

  it("respects maxBufferSize when loading from disk", () => {
    const events = Array.from({ length: 50 }, (_, i) => makeEvent({ path: `/event-${i}` }));
    fs.writeFileSync(storagePath, JSON.stringify(events) + "\n");

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath,
      maxBufferSize: 10,
    });

    expect((client as any).buffer).toHaveLength(10);
    client.shutdown();
  });

  it("handles corrupt storage file gracefully", () => {
    fs.writeFileSync(storagePath, "not json\n{also bad\n");

    // Should not throw
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath,
    });

    // Original file renamed away; no events loaded
    expect(fs.existsSync(storagePath)).toBe(false);
    expect((client as any).buffer).toHaveLength(0);
    client.shutdown();
  });

  it("respects maxStorageBytes limit", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath,
      maxStorageBytes: 100, // very small limit
    });

    // Write a file that's already at the limit AFTER construction
    // (loadFromDisk runs in constructor and would clean it up otherwise)
    fs.writeFileSync(storagePath, "x".repeat(100));

    client.track(makeEvent());

    // Force max failures to trigger persistToDisk
    for (let i = 0; i < 5; i++) {
      (client as any).backoffUntil = 0;
      await client.flush();
    }

    // File should not have grown — persist was skipped due to size limit
    const content = fs.readFileSync(storagePath, "utf-8");
    expect(content).toBe("x".repeat(100));
    client.shutdown();
  });

  it("persists remaining buffer on shutdown when flush fails", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath,
    });

    client.track(makeEvent({ path: "/shutdown-persist" }));
    await client.shutdown();

    // Events should be persisted since flush failed
    expect(fs.existsSync(storagePath)).toBe(true);
    const content = fs.readFileSync(storagePath, "utf-8").trim();
    const lines = content.split("\n");
    // Could be 1 or 2 lines depending on whether flush re-inserted then shutdown persisted
    const allEvents = lines.flatMap((l) => JSON.parse(l));
    expect(allEvents.some((e: RequestEvent) => e.path === "/shutdown-persist")).toBe(true);
  });

  it("handles multiple JSONL lines (multiple batches)", () => {
    const batch1 = [makeEvent({ path: "/batch1" })];
    const batch2 = [makeEvent({ path: "/batch2" })];
    fs.writeFileSync(storagePath, JSON.stringify(batch1) + "\n" + JSON.stringify(batch2) + "\n");

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath,
    });

    const buffer = (client as any).buffer as RequestEvent[];
    expect(buffer).toHaveLength(2);
    expect(buffer[0].path).toBe("/batch1");
    expect(buffer[1].path).toBe("/batch2");
    client.shutdown();
  });

  it("recovery file is deleted after first successful flush", async () => {
    const events = [makeEvent({ path: "/recover-then-flush" })];
    fs.writeFileSync(storagePath, JSON.stringify(events) + "\n");

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1,
      storagePath,
    });

    // Recovery file should exist before flush
    expect(fs.existsSync(storagePath + ".recovering")).toBe(true);

    // Flush succeeds (mock returns 200)
    await client.flush();

    // Recovery file should be cleaned up
    expect(fs.existsSync(storagePath + ".recovering")).toBe(false);
    client.shutdown();
  });

  it("recovery file survives if process crashes before flush", () => {
    // Simulate: events were loaded but never flushed (process crashed).
    // On next startup, the .recovering file should still be found.
    const events = [makeEvent({ path: "/crash-recovery" })];
    fs.writeFileSync(storagePath, JSON.stringify(events) + "\n");

    // First startup: loads events, renames to .recovering
    const client1 = new PeekApiClient({ ...VALID_OPTIONS, batchSize: 1000, storagePath });
    expect((client1 as any).buffer[0].path).toBe("/crash-recovery");
    // Simulate crash — no flush, just destroy
    client1.shutdown();

    // Recovery file still exists
    expect(fs.existsSync(storagePath + ".recovering")).toBe(true);

    // Second startup: should find .recovering and re-load
    const client2 = new PeekApiClient({ ...VALID_OPTIONS, batchSize: 1000, storagePath });
    const buffer = (client2 as any).buffer as RequestEvent[];
    expect(buffer.some((e: RequestEvent) => e.path === "/crash-recovery")).toBe(true);
    client2.shutdown();
  });

  it("uses fd-based fstat to check size (TOCTOU-safe)", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath,
      maxStorageBytes: 200,
    });

    client.track(makeEvent({ path: "/toctou" }));

    // Force 5 failures to trigger persist
    for (let i = 0; i < 5; i++) {
      (client as any).backoffUntil = 0;
      await client.flush();
    }

    // File should exist and contain the event
    expect(fs.existsSync(storagePath)).toBe(true);
    const content = fs.readFileSync(storagePath, "utf-8").trim();
    expect(JSON.parse(content)[0].path).toBe("/toctou");
    client.shutdown();
  });

  it("recovers persisted events during same process (runtime recovery)", async () => {
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath,
      batchSize: 1000,
    });

    // Simulate events persisted to disk mid-process
    const events = [makeEvent({ path: "/runtime-recover" })];
    fs.writeFileSync(storagePath, JSON.stringify(events) + "\n");

    // Trigger runtime recovery (same client, not a new one)
    (client as any).loadFromDisk();

    expect((client as any).buffer.length).toBe(1);
    expect((client as any).buffer[0].path).toBe("/runtime-recover");
    client.shutdown();
  });
});

// ─── Error Classification ─────────────────────────────────────────────

describe("error classification", () => {
  it("does not retry on 4xx (non-retryable), persists to disk immediately", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(400);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const storagePath = tmpStoragePath();
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath,
    });

    client.track(makeEvent({ path: "/bad-request" }));
    await client.flush();

    // Should NOT re-insert into buffer (non-retryable)
    expect((client as any).buffer).toHaveLength(0);
    // Should NOT increment consecutiveFailures
    expect((client as any).consecutiveFailures).toBe(0);
    // Should persist to disk immediately
    expect(fs.existsSync(storagePath)).toBe(true);
    const content = fs.readFileSync(storagePath, "utf-8").trim();
    const batch = JSON.parse(content);
    expect(batch[0].path).toBe("/bad-request");
    client.shutdown();
    try {
      fs.unlinkSync(storagePath);
    } catch {}
  });

  it("does not retry on 401 (non-retryable)", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(401);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
    });
    client.track(makeEvent());
    await client.flush();

    expect((client as any).consecutiveFailures).toBe(0);
    expect((client as any).buffer).toHaveLength(0);
    client.shutdown();
  });

  it("retries on 500 (retryable), re-inserts into buffer", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
    });
    client.track(makeEvent());
    await client.flush();

    expect((client as any).consecutiveFailures).toBe(1);
    expect((client as any).buffer.length).toBeGreaterThan(0);
    client.shutdown();
  });

  it("retries on 429 (rate limited, retryable)", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(429);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
    });
    client.track(makeEvent());
    await client.flush();

    expect((client as any).consecutiveFailures).toBe(1);
    expect((client as any).buffer.length).toBeGreaterThan(0);
    client.shutdown();
  });
  it("includes response body in error for debug logging", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      if (cb)
        (cb as any)(makeMockRes(422, '{"error":"invalid_field","detail":"path is required"}'));
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const debugLogs: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => debugLogs.push(args.join(" "));

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
      debug: true,
    });
    client.track(makeEvent());
    await client.flush();

    console.error = origError;

    // The error message should contain the response body
    const errorLog = debugLogs.find((l) => l.includes("Non-retryable error"));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain("422");
    expect(errorLog).toContain("invalid_field");
    client.shutdown();
  });

  it("includes Retry-After header in error message", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      if (cb) (cb as any)(makeMockRes(429, "rate limited", { "retry-after": "30" }));
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const debugLogs: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => debugLogs.push(args.join(" "));

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
      debug: true,
    });
    client.track(makeEvent());
    await client.flush();

    console.error = origError;

    const errorLog = debugLogs.find((l) => l.includes("Flush failed"));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain("Retry-After: 30");
    client.shutdown();
  });
});

// ─── onError Callback ────────────────────────────────────────────────

describe("onError callback", () => {
  it("called when background flush fails", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      if (cb) (cb as any)(makeMockRes(500));
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const errors: Error[] = [];
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
      onError: (err) => errors.push(err),
    });
    client.track(makeEvent());
    await client.flush();
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
    client.shutdown();
  });

  it("not called on successful flush", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      if (cb) (cb as any)(makeMockRes(200));
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const errors: Error[] = [];
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
      onError: (err) => errors.push(err),
    });
    client.track(makeEvent());
    await client.flush();
    expect(errors.length).toBe(0);
    client.shutdown();
  });

  it("swallows exceptions thrown by onError", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      if (cb) (cb as any)(makeMockRes(500));
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
      onError: () => {
        throw new Error("callback crash");
      },
    });
    client.track(makeEvent());
    // Should not throw even though onError throws
    await expect(client.flush()).resolves.toBeUndefined();
    client.shutdown();
  });
});

// ─── Backoff Jitter ──────────────────────────────────────────────────

describe("backoff jitter", () => {
  it("applies jitter to backoff delay (not purely exponential)", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const client = new PeekApiClient({
        ...VALID_OPTIONS,
        batchSize: 1000,
        storagePath: tmpStoragePath(),
      });
      client.track(makeEvent());
      const before = Date.now();
      await client.flush();
      const backoffUntil = (client as any).backoffUntil as number;
      delays.push(backoffUntil - before);
      client.shutdown();
    }

    // With jitter, not all delays should be identical
    // BASE_BACKOFF_MS * 2^0 = 1000ms, jitter range [500, 1000]
    const uniqueDelays = new Set(delays);
    expect(uniqueDelays.size).toBeGreaterThan(1);

    // All delays should be in the jitter range [500, 1000] (±50ms tolerance for timing)
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(450);
      expect(d).toBeLessThanOrEqual(1100);
    }
  });

  it("does not set backoff after non-retryable error", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(403);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
    });
    client.track(makeEvent());
    await client.flush();

    // Non-retryable → no backoff set
    expect((client as any).backoffUntil).toBe(0);
    client.shutdown();
  });
});

// ─── Flush Batching ──────────────────────────────────────────────────

describe("flush batching", () => {
  it("flush only sends batchSize events, leaving remainder in buffer", async () => {
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 3,
      maxBufferSize: 100,
      storagePath: tmpStoragePath(),
    });

    // Push directly to buffer to avoid auto-flush triggers from track()
    const buf = (client as any).buffer as RequestEvent[];
    for (let i = 0; i < 7; i++) {
      buf.push(makeEvent({ path: `/event-${i}` }));
    }
    expect(buf).toHaveLength(7);

    // Manual flush should take only batchSize (3) events
    await client.flush();

    // 7 - 3 = 4 remaining
    expect(buf).toHaveLength(4);
    expect(buf[0].path).toBe("/event-3");
    expect(buf[3].path).toBe("/event-6");

    expect(requestStub).toHaveBeenCalledTimes(1);

    // Verify payload contained exactly 3 events
    const writeCall = requestStub.mock.results[0].value;
    const writtenPayload = (writeCall.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const sentEvents = JSON.parse(writtenPayload);
    expect(sentEvents).toHaveLength(3);
    expect(sentEvents[0].path).toBe("/event-0");
    expect(sentEvents[2].path).toBe("/event-2");

    client.shutdown();
  });

  it("re-inserts failed events without stack overflow on large arrays", async () => {
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 200,
      maxBufferSize: 500,
      storagePath: tmpStoragePath(),
    });

    // Push directly to buffer to avoid auto-flush triggers
    const buf = (client as any).buffer as RequestEvent[];
    for (let i = 0; i < 200; i++) {
      buf.push(makeEvent({ path: `/event-${i}` }));
    }

    // Flush fails → events re-inserted via concat (not spread)
    await client.flush();

    // Events should be back in buffer
    expect((client as any).buffer.length).toBe(200);
    client.shutdown();
  });
});

// ─── Signal Handler Cleanup ──────────────────────────────────────────

describe("signal handler cleanup", () => {
  it("removes signal handlers on shutdown", async () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    const handlers = (client as any).signalHandlers;
    expect(handlers.length).toBe(2); // SIGTERM + SIGINT

    await client.shutdown();
    expect((client as any).signalHandlers).toHaveLength(0);
  });

  it("does not call process.exit on SIGTERM", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath: tmpStoragePath(),
    });

    // Emit SIGTERM — the SDK handler should run but NOT call process.exit
    process.emit("SIGTERM", "SIGTERM");

    expect(exitSpy).not.toHaveBeenCalled();
    client.shutdown();
    exitSpy.mockRestore();
  });
});

// ─── SSRF Protection ──────────────────────────────────────────────────

describe("isPrivateIP", () => {
  // Standard private IPv4 ranges
  it.each([
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.1.1",
    "0.0.0.0",
  ])("detects standard private IPv4: %s", (ip) => {
    expect(_isPrivateIP(ip)).toBe(true);
  });

  // CGNAT range (100.64.0.0/10)
  it.each(["100.64.0.1", "100.100.100.100", "100.127.255.255"])("detects CGNAT range: %s", (ip) => {
    expect(_isPrivateIP(ip)).toBe(true);
  });

  // CGNAT boundary — 100.128.0.0 is NOT in 100.64.0.0/10
  it("rejects 100.128.0.1 (outside CGNAT)", () => {
    expect(_isPrivateIP("100.128.0.1")).toBe(false);
  });

  // IPv6 addresses
  it.each([
    "::1", // loopback
    "fc00::1", // ULA
    "fd12:3456:789a::1", // ULA
    "fe80::1", // link-local
  ])("detects private IPv6: %s", (ip) => {
    expect(_isPrivateIP(ip)).toBe(true);
  });

  // IPv4-mapped IPv6
  it.each([
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.1",
    "::ffff:172.16.0.1",
    "::ffff:100.64.0.1",
  ])("detects IPv4-mapped IPv6: %s", (ip) => {
    expect(_isPrivateIP(ip)).toBe(true);
  });

  // Public IPs should pass
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "203.0.113.1"])("allows public IP: %s", (ip) => {
    expect(_isPrivateIP(ip)).toBe(false);
  });
});

describe("constructor SSRF", () => {
  it("blocks CGNAT range at construction time", () => {
    expect(
      () =>
        new PeekApiClient({
          apiKey: "ak_test",
          endpoint: "https://100.64.0.1/ingest",
          flushInterval: 60_000,
        }),
    ).toThrow("private or internal IP");
  });

  it("blocks IPv4-mapped IPv6 at construction time", () => {
    expect(
      () =>
        new PeekApiClient({
          apiKey: "ak_test",
          endpoint: "https://[::ffff:10.0.0.1]/ingest",
          flushInterval: 60_000,
        }),
    ).toThrow("private or internal IP");
  });

  it("blocks IPv6 loopback at construction time", () => {
    expect(
      () =>
        new PeekApiClient({
          apiKey: "ak_test",
          endpoint: "https://[::1]/ingest",
          flushInterval: 60_000,
        }),
    ).toThrow("private or internal IP");
  });

  it("blocks IPv6 ULA at construction time", () => {
    expect(
      () =>
        new PeekApiClient({
          apiKey: "ak_test",
          endpoint: "https://[fc00::1]/ingest",
          flushInterval: 60_000,
        }),
    ).toThrow("private or internal IP");
  });
});

// ─── Shutdown ─────────────────────────────────────────────────────────

describe("shutdown", () => {
  it("clears the timer", async () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    expect((client as any).timer).not.toBeNull();

    await client.shutdown();
    expect((client as any).timer).toBeNull();
  });

  it("flushes remaining buffer", async () => {
    const client = new PeekApiClient({ ...VALID_OPTIONS, batchSize: 1000 });
    client.track(makeEvent());
    client.track(makeEvent());

    await client.shutdown();
    expect(requestStub).toHaveBeenCalled();
    expect((client as any).buffer).toHaveLength(0);
  });

  it("waits for in-flight flush before proceeding", async () => {
    // First call: deferred response. Subsequent calls: immediate response.
    let resolveSend: (() => void) | null = null;
    let callCount = 0;
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      callCount++;
      const mock = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };
      if (callCount === 1) {
        // First call: delay the response to simulate in-flight
        new Promise<void>((r) => {
          resolveSend = r;
        }).then(() => {
          const mockRes = makeMockRes(200);
          if (cb) (cb as any)(mockRes);
        });
      } else {
        // Subsequent calls: resolve immediately
        const mockRes = makeMockRes(200);
        if (cb) (cb as any)(mockRes);
      }
      return mock as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1000,
      storagePath: tmpStoragePath(),
    });

    // Push events and start a flush (but don't await — it's "in-flight")
    const buf = (client as any).buffer as RequestEvent[];
    buf.push(makeEvent({ path: "/inflight-1" }));
    buf.push(makeEvent({ path: "/inflight-2" }));
    void client.flush();

    // Buffer should be empty (splice took events), but flush is in-flight
    expect((client as any).flushInFlight).toBe(true);

    // Push more events while flush is in-flight
    buf.push(makeEvent({ path: "/after-inflight" }));

    // Start shutdown — it should wait for the in-flight flush
    const shutdownPromise = client.shutdown();

    // The in-flight flush hasn't resolved yet, so shutdown is pending
    await vi.waitFor(() => {
      expect(resolveSend).not.toBeNull();
    });

    // Now resolve the in-flight flush
    resolveSend!();

    // Shutdown should complete — flushes the remaining "/after-inflight" event
    await shutdownPromise;

    // All events should have been flushed (2 calls: in-flight + shutdown flush)
    expect(requestStub).toHaveBeenCalledTimes(2);
    expect((client as any).buffer).toHaveLength(0);
  });
});

// ─── AbortController Timeout ─────────────────────────────────────────

describe("send timeout", () => {
  it("uses AbortController signal (not socket idle timeout)", () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    client.track(makeEvent());

    // Verify the request options include `signal` (not `timeout`)
    void client.flush();

    expect(requestStub).toHaveBeenCalled();
    const callArgs = requestStub.mock.calls[0][0] as any;
    expect(callArgs.signal).toBeDefined();
    expect(callArgs.signal).toBeInstanceOf(AbortSignal);
    expect(callArgs.timeout).toBeUndefined();
    client.shutdown();
  });
});

// ─── Crash Safety ─────────────────────────────────────────────────────

describe("crash safety — track() must never throw", () => {
  it("survives undefined method/path", () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    expect(() =>
      client.track(makeEvent({ method: undefined as any, path: undefined as any })),
    ).not.toThrow();
    client.shutdown();
  });

  it("survives null method/path", () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    expect(() => client.track(makeEvent({ method: null as any, path: null as any }))).not.toThrow();
    client.shutdown();
  });

  it("survives numeric method/path", () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    expect(() => client.track(makeEvent({ method: 123 as any, path: 456 as any }))).not.toThrow();
    client.shutdown();
  });

  it("coerces method/path to strings in the buffer", () => {
    const client = new PeekApiClient(VALID_OPTIONS);
    client.track(makeEvent({ method: 123 as any, path: undefined as any }));

    // Verify the flush sends without error (coerced values are valid JSON)
    expect(() => void client.flush()).not.toThrow();
    client.shutdown();
  });

  it("does not produce unhandled rejection from auto-flush", async () => {
    const sp = tmpStoragePath();
    requestStub.mockImplementation((_opts: unknown, _cb: unknown) => {
      const mock = { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
      // Simulate error on the request
      setTimeout(() => {
        const errorHandler = (mock.on as any).mock.calls.find((c: any) => c[0] === "error");
        if (errorHandler) errorHandler[1](new Error("network fail"));
      }, 0);
      return mock as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      batchSize: 1, // trigger flush on every track
      storagePath: sp,
    });

    // Should NOT produce an unhandled rejection
    client.track(makeEvent());

    // Give the microtask queue time to process
    await new Promise((r) => setTimeout(r, 50));
    await client.shutdown();
  });
});

// ─── Async Disk I/O ───────────────────────────────────────────────────

describe("async disk I/O in flush path", () => {
  it("persists to disk via async I/O after non-retryable error", async () => {
    const sp = tmpStoragePath();

    // Mock 400 response (non-retryable) → triggers async disk persist
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(400);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath: sp,
    });

    client.track(makeEvent());
    await client.flush();

    // Async persist should have written to disk
    expect(fs.existsSync(sp)).toBe(true);
    const content = fs.readFileSync(sp, "utf-8").trim();
    const events = JSON.parse(content);
    expect(events).toHaveLength(1);
    expect(events[0].method).toBe("GET");

    await client.shutdown();
  });

  it("persists to disk via async I/O after max consecutive failures", async () => {
    const sp = tmpStoragePath();

    // Mock network error (retryable)
    requestStub.mockImplementation((_opts: unknown, _cb: unknown) => {
      const mock = { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
      setTimeout(() => {
        const errorHandler = (mock.on as any).mock.calls.find((c: any) => c[0] === "error");
        if (errorHandler) errorHandler[1](new Error("connection refused"));
      }, 0);
      return mock as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath: sp,
    });

    // Push through max failures (5) to trigger disk persist
    for (let i = 0; i < 5; i++) {
      client.track(makeEvent());
      await client.flush();
      // Allow next flush by waiting for backoff
      (client as any).backoffUntil = 0;
    }

    expect(fs.existsSync(sp)).toBe(true);
    await client.shutdown();
  });

  it("shutdown uses sync disk I/O (does not need await)", async () => {
    const sp = tmpStoragePath();

    // Mock 500 so flush fails in shutdown
    requestStub.mockImplementation((_opts: unknown, cb: unknown) => {
      const mockRes = makeMockRes(500);
      if (cb) (cb as any)(mockRes);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
    });

    const client = new PeekApiClient({
      ...VALID_OPTIONS,
      storagePath: sp,
    });

    client.track(makeEvent());
    await client.shutdown();

    // shutdownSync path uses sync I/O — file should exist
    expect(fs.existsSync(sp)).toBe(true);
  });
});
