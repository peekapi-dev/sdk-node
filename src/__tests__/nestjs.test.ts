import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "https";
import { of } from "rxjs";
import { PeekApiInterceptor } from "../middleware/nestjs";
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

// Mock ExecutionContext and CallHandler
function mockContext(
  overrides: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    statusCode?: number;
  } = {},
) {
  const request = {
    method: overrides.method ?? "GET",
    url: overrides.url ?? "/test",
    route: { path: overrides.url ?? "/test" },
    headers: overrides.headers ?? {},
  };

  const response = {
    statusCode: overrides.statusCode ?? 200,
    getHeader: vi.fn().mockReturnValue(undefined),
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  };

  return { context, request, response };
}

function mockCallHandler(result: any = { ok: true }) {
  return {
    handle: () => of(result),
  };
}

// ─── Interceptor Wiring ────────────────────────────────────────────

describe("PeekApiInterceptor", () => {
  it("creates without errors", () => {
    const interceptor = new PeekApiInterceptor(VALID_OPTIONS);
    expect(interceptor).toBeDefined();
  });

  it("returns an observable from intercept()", () => {
    const interceptor = new PeekApiInterceptor(VALID_OPTIONS);
    const { context } = mockContext();
    const handler = mockCallHandler();

    const result = interceptor.intercept(context, handler);
    expect(result).toBeDefined();
    expect(result.pipe).toBeDefined();
  });

  it("passes through the handler result", async () => {
    const interceptor = new PeekApiInterceptor(VALID_OPTIONS);
    const { context } = mockContext();
    const handler = mockCallHandler({ items: [1, 2, 3] });

    const result = await new Promise((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        next: (value: any) => resolve(value),
      });
    });

    expect(result).toEqual({ items: [1, 2, 3] });
  });
});

// ─── Consumer Identification ────────────────────────────────────────

describe("consumer identification", () => {
  it("uses x-api-key header as consumer_id", async () => {
    const interceptor = new PeekApiInterceptor(VALID_OPTIONS);
    const { context } = mockContext({ headers: { "x-api-key": "key_consumer_123" } });
    const handler = mockCallHandler();

    const result = await new Promise((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        next: (value: any) => resolve(value),
      });
    });

    expect(result).toEqual({ ok: true });
  });

  it("uses custom identifyConsumer callback", async () => {
    const identifySpy = vi.fn().mockReturnValue("tenant-42");
    const interceptor = new PeekApiInterceptor({
      ...VALID_OPTIONS,
      identifyConsumer: identifySpy,
    });
    const { context } = mockContext();
    const handler = mockCallHandler();

    await new Promise((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        next: (value: any) => resolve(value),
      });
    });

    expect(identifySpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Crash Safety ───────────────────────────────────────────────────

describe("crash safety — interceptor must never break customer API", () => {
  it("still passes through result when identifyConsumer throws", async () => {
    const interceptor = new PeekApiInterceptor({
      ...VALID_OPTIONS,
      identifyConsumer: () => {
        throw new Error("consumer callback exploded");
      },
    });
    const { context } = mockContext();
    const handler = mockCallHandler({ ok: true });

    const result = await new Promise((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        next: (value: any) => resolve(value),
      });
    });

    expect(result).toEqual({ ok: true });
  });

  it("handles missing request properties gracefully", async () => {
    const interceptor = new PeekApiInterceptor(VALID_OPTIONS);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: "POST",
          url: "/empty",
          headers: {},
        }),
        getResponse: () => ({
          statusCode: 204,
          getHeader: vi.fn().mockReturnValue(undefined),
        }),
      }),
    };
    const handler = mockCallHandler();

    const result = await new Promise((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        next: (value: any) => resolve(value),
      });
    });

    expect(result).toEqual({ ok: true });
  });
});

// ─── collectQueryString ──────────────────────────────────────────────

describe("collectQueryString option", () => {
  it("does not throw when collectQueryString is true", async () => {
    const interceptor = new PeekApiInterceptor({ ...VALID_OPTIONS, collectQueryString: true });
    const { context } = mockContext({ url: "/search?z=3&a=1" });
    const handler = mockCallHandler({ results: [] });

    const result = await new Promise((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        next: (value: any) => resolve(value),
      });
    });

    expect(result).toEqual({ results: [] });
  });

  it("handles request without query string when enabled", async () => {
    const interceptor = new PeekApiInterceptor({ ...VALID_OPTIONS, collectQueryString: true });
    const { context } = mockContext({ url: "/users" });
    const handler = mockCallHandler([]);

    const result = await new Promise((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        next: (value: any) => resolve(value),
      });
    });

    expect(result).toEqual([]);
  });
});
