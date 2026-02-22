import dns from "dns";
import http from "http";
import https from "https";
import { createHash } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { URL } from "url";
import type { ApiDashOptions, RequestEvent } from "./types";

// Replaced at build time by APIDASH_DEFAULT_ENDPOINT env var
const DEFAULT_ENDPOINT = "__APIDASH_DEFAULT_ENDPOINT__";

const DEFAULT_FLUSH_INTERVAL = 10_000; // 10 seconds
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;
const MAX_PATH_LENGTH = 2048;
const MAX_METHOD_LENGTH = 16;
const MAX_CONSECUTIVE_FAILURES = 5;
const BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_STORAGE_BYTES = 5_242_880; // 5MB
const SEND_TIMEOUT_MS = 5_000; // total request timeout (DNS + TCP + TLS + response)
const DNS_CACHE_TTL_MS = 60_000; // 60 seconds
const DEFAULT_MAX_EVENT_BYTES = 65_536; // 64KB per event

// Status codes worth retrying — everything else is a permanent failure
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// Private/loopback/link-local IP ranges (SSRF protection)
// Covers: IPv4 private ranges, loopback, link-local, CGNAT (100.64/10),
// IPv6 loopback, ULA, link-local, and IPv4-mapped IPv6 (::ffff:x.x.x.x)
const PRIVATE_IP_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|0{0,4}:{0,4}0{0,4}:{0,4}0{0,4}:{0,4}0{0,4}:{0,4}0{0,4}:{0,4}0{0,4}:{0,4}0{0,4}:{0,4}0{0,2}1$|fc|fd|fe80|::ffff:)/i;

/**
 * Check if a resolved IP address is private/internal.
 * Uses net.isIP() to parse the address, then checks against private ranges.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 addresses.
 */
function isPrivateIP(ip: string): boolean {
  // Fast path: regex check on the string representation
  if (PRIVATE_IP_RE.test(ip)) return true;

  // Parse IPv4-mapped IPv6 addresses like ::ffff:10.0.0.1
  // Node's net module normalizes these, so extract the IPv4 part
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) {
    return PRIVATE_IP_RE.test(v4Mapped[1]);
  }

  // Parse actual IP to check numerically for edge cases
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 100.64.0.0/10 (CGNAT)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 169.254.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
  }

  return false;
}

/** Exported for testing. */
export { isPrivateIP as _isPrivateIP };

export class ApiDashClient {
  private apiKey: string;
  private parsedUrl: URL;
  private flushInterval: number;
  private batchSize: number;
  private maxBufferSize: number;
  private debug: boolean;
  private buffer: RequestEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushInFlight = false;
  private flushPromise: Promise<void> = Promise.resolve();
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private useHttp: boolean;
  private agent: http.Agent | https.Agent;
  private storagePath: string;
  private maxStorageBytes: number;
  private maxEventBytes: number;
  private onError: ((err: Error) => void) | undefined;
  private recoveryPath: string | null = null; // set when loadFromDisk renames the file
  private signalHandlers: { signal: string; handler: () => void }[] = [];

  constructor(options: ApiDashOptions) {
    const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;

    if (!endpoint || endpoint === "__APIDASH_DEFAULT_ENDPOINT__") {
      throw new Error(
        "[apidash] 'endpoint' is required. Either pass it in options or build the SDK " +
          "with APIDASH_DEFAULT_ENDPOINT env var set.",
      );
    }

    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`[apidash] Invalid endpoint URL: ${endpoint}`);
    }

    // Enforce HTTPS (allow http://localhost and http://127.0.0.1 for local dev)
    // NOTE: url.hostname wraps IPv6 in brackets (e.g. "[::1]"), so strip them
    const bareHostname = url.hostname.replace(/^\[|\]$/g, "");
    const isLocalhost = bareHostname === "localhost" || bareHostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocalhost) {
      throw new Error(
        "[apidash] Endpoint must use HTTPS. Plain HTTP is only allowed for localhost.",
      );
    }

    // SSRF protection: block private/loopback IPs (except localhost for dev)
    if (!isLocalhost && isPrivateIP(bareHostname)) {
      throw new Error("[apidash] Endpoint must not point to a private or internal IP address.");
    }

    // Strip any embedded credentials
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      if (options.debug) {
        console.warn("[apidash] Stripped embedded credentials from endpoint URL");
      }
    }

    this.parsedUrl = url;

    // Validate API key
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new Error("[apidash] 'apiKey' is required and must be a string.");
    }
    // eslint-disable-next-line no-control-regex
    if (/[\r\n\0]/.test(options.apiKey)) {
      throw new Error("[apidash] 'apiKey' contains invalid characters.");
    }
    this.apiKey = options.apiKey;

    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.debug = options.debug ?? false;
    this.useHttp = url.protocol === "http:";

    // DNS cache with TTL + SSRF validation. Eliminates per-socket DNS lookups
    // while still preventing DNS rebinding attacks. Cache is per-client instance.
    const dnsCache = new Map<string, { address: string; family: number; expires: number }>();

    // Custom DNS lookup that validates resolved IPs to prevent DNS rebinding attacks.
    // A hostname could initially resolve to a public IP (passing construction-time checks)
    // then later resolve to a private IP (e.g., 127.0.0.1, 169.254.169.254).
    // Skipped for localhost since private IPs are expected there.
    const agentOpts: http.AgentOptions = { keepAlive: true, maxSockets: 2 };
    if (!isLocalhost) {
      const ssrfSafeLookup = (hostname: string, opts: any, callback: any) => {
        const cached = dnsCache.get(hostname);
        if (cached && Date.now() < cached.expires) {
          return callback(null, cached.address, cached.family);
        }

        dns.lookup(hostname, opts, (err, address, family) => {
          if (err) return callback(err, address, family);
          if (typeof address === "string" && isPrivateIP(address)) {
            return callback(
              new Error(`[apidash] DNS resolved to private IP ${address} (SSRF protection)`),
              address,
              family,
            );
          }
          dnsCache.set(hostname, {
            address: address as string,
            family,
            expires: Date.now() + DNS_CACHE_TTL_MS,
          });
          callback(null, address, family);
        });
      };
      agentOpts.lookup = ssrfSafeLookup;
    }

    this.agent = this.useHttp
      ? new http.Agent(agentOpts)
      : new https.Agent({ ...agentOpts, ...options.tlsOptions });
    this.maxStorageBytes = options.maxStorageBytes ?? DEFAULT_MAX_STORAGE_BYTES;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.onError = options.onError;
    this.storagePath =
      options.storagePath ??
      path.join(
        os.tmpdir(),
        `apidash-events-${createHash("md5").update(endpoint).digest("hex").slice(0, 8)}.jsonl`,
      );

    this.loadFromDisk();
    this.startTimer();
    this.registerSignalHandlers();
  }

  track(event: RequestEvent): void {
    try {
      // Sanitize input lengths
      event.method = String(event.method ?? "").slice(0, MAX_METHOD_LENGTH);
      event.path = String(event.path ?? "").slice(0, MAX_PATH_LENGTH);
      if (event.consumer_id) {
        event.consumer_id = String(event.consumer_id).slice(0, 256);
      }

      // Enforce per-event size limit. If too large, strip metadata first;
      // if still too large, drop the event entirely.
      if (event.metadata !== undefined) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (size > this.maxEventBytes) {
          delete event.metadata;
          if (this.debug) {
            console.warn(
              `[apidash] Event exceeded ${this.maxEventBytes} bytes — metadata stripped`,
            );
          }
          const reduced = Buffer.byteLength(JSON.stringify(event));
          if (reduced > this.maxEventBytes) {
            if (this.debug) {
              console.warn(
                `[apidash] Event still exceeds limit after stripping metadata (${reduced}B) — dropped`,
              );
            }
            return;
          }
        }
      }

      this.buffer.push(event);

      // Trigger flush when buffer reaches batchSize OR maxBufferSize.
      // At maxBufferSize the flush drains events to the server, preventing
      // the buffer from growing without bound. If the endpoint is down,
      // the existing retry + backoff + disk-persist-after-max-failures
      // mechanism kicks in.
      if (this.buffer.length >= this.batchSize) {
        this.flush().catch(this.onInternalError);
      }
    } catch (err) {
      this.onInternalError(err);
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushInFlight) return;

    // Exponential backoff: skip flush if backing off
    if (this.consecutiveFailures > 0 && Date.now() < this.backoffUntil) {
      return;
    }

    this.flushInFlight = true;
    const events = this.buffer.splice(0, this.batchSize);

    this.flushPromise = this.doFlush(events);
    await this.flushPromise;
  }

  private async doFlush(events: RequestEvent[]): Promise<void> {
    try {
      await this.send(events);
      this.consecutiveFailures = 0;
      this.backoffUntil = 0;
      this.cleanupRecoveryFile();
      if (this.debug) {
        console.log(`[apidash] Flushed ${events.length} events`);
      }
    } catch (err) {
      if (this.onError) {
        try {
          this.onError(err instanceof Error ? err : new Error(String(err)));
        } catch {
          /* never crash */
        }
      }
      const isRetryable = (err as any).retryable !== false;

      if (!isRetryable) {
        // Non-retryable (4xx) — persist to disk, don't waste retry budget
        await this.persistToDiskAsync(events);
        if (this.debug) {
          console.error(
            `[apidash] Non-retryable error, persisted to disk:`,
            (err as Error).message,
          );
        }
      } else {
        this.consecutiveFailures++;

        // After max failures, persist to disk instead of dropping
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await this.persistToDiskAsync(events);
          this.consecutiveFailures = 0;
        } else {
          // Re-insert only up to remaining capacity
          const capacity = this.maxBufferSize - this.buffer.length;
          if (capacity > 0) {
            this.buffer = events.slice(0, capacity).concat(this.buffer);
          }
          if (this.debug) {
            console.error(
              `[apidash] Flush failed (attempt ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
              (err as Error).message,
            );
          }
        }

        // Exponential backoff with jitter: base * 2^(n-1) * random(0.5..1.0)
        if (this.consecutiveFailures > 0) {
          const base = BASE_BACKOFF_MS * Math.pow(2, this.consecutiveFailures - 1);
          const delay = base * (0.5 + Math.random() * 0.5);
          this.backoffUntil = Date.now() + delay;
        }
      }
    } finally {
      this.flushInFlight = false;
    }
  }

  async shutdown(): Promise<void> {
    this.removeSignalHandlers();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any in-flight flush to complete before proceeding.
    // Without this, flush() returns immediately (flushInFlight guard),
    // and we'd persist an incomplete buffer while the in-flight request
    // is still sending events.
    await this.flushPromise;
    await this.flush();
    // If buffer still has events (flush failed or was skipped), persist to disk
    if (this.buffer.length > 0) {
      this.persistToDiskSync(this.buffer.splice(0));
    }
    this.agent.destroy();
  }

  /** Synchronous shutdown for signal handlers (async won't complete during exit) */
  private shutdownSync(): void {
    this.removeSignalHandlers();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      this.persistToDiskSync(this.buffer.splice(0));
    }
    this.agent.destroy();
  }

  /** Swallow internal errors — an analytics SDK must never crash the host app. */
  private onInternalError = (err: unknown): void => {
    if (this.debug) {
      console.error("[apidash] Internal error (suppressed):", (err as Error).message ?? err);
    }
  };

  private startTimer(): void {
    this.timer = setInterval(() => this.flush().catch(this.onInternalError), this.flushInterval);
    // Allow the process to exit even if the timer is running
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /** Persist events to disk (async — non-blocking, for use in flush path).
   *  Opens a single fd with O_APPEND, then fstat+write on that fd. This
   *  eliminates the TOCTOU race between a separate stat() and appendFile().
   *  O_APPEND also provides kernel-level write atomicity on POSIX, preventing
   *  JSONL line corruption when multiple cluster workers share the file. */
  private async persistToDiskAsync(events: RequestEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      const fd = await fsp.open(
        this.storagePath,
        fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY,
        0o600,
      );
      try {
        const stat = await fd.stat();
        if (stat.size >= this.maxStorageBytes) {
          if (this.debug) {
            console.warn(
              `[apidash] Storage file full (${stat.size} bytes), skipping disk persist of ${events.length} events`,
            );
          }
          return;
        }
        await fd.write(JSON.stringify(events) + "\n");
        if (this.debug) {
          console.log(`[apidash] Persisted ${events.length} events to ${this.storagePath}`);
        }
      } finally {
        await fd.close();
      }
    } catch (err) {
      if (this.debug) {
        console.error("[apidash] Failed to persist events to disk:", (err as Error).message);
      }
    }
  }

  /** Persist events to disk (synchronous — for shutdownSync / signal handlers).
   *  Same fd-based pattern as persistToDiskAsync for TOCTOU and atomicity. */
  private persistToDiskSync(events: RequestEvent[]): void {
    if (events.length === 0) return;
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        this.storagePath,
        fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY,
        0o600,
      );
      const stat = fs.fstatSync(fd);
      if (stat.size >= this.maxStorageBytes) {
        if (this.debug) {
          console.warn(
            `[apidash] Storage file full (${stat.size} bytes), skipping disk persist of ${events.length} events`,
          );
        }
        return;
      }
      fs.writeSync(fd, JSON.stringify(events) + "\n");
      if (this.debug) {
        console.log(`[apidash] Persisted ${events.length} events to ${this.storagePath}`);
      }
    } catch (err) {
      if (this.debug) {
        console.error("[apidash] Failed to persist events to disk:", (err as Error).message);
      }
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Load persisted events from disk back into buffer (called once at startup).
   *  The storage file is renamed (not deleted) after loading. It is only
   *  deleted after the first successful flush, so a crash between load and
   *  flush does not lose events — the next startup will find the renamed
   *  file and re-load from it. */
  private loadFromDisk(): void {
    // Check for a leftover recovery file from a previous crash-before-flush
    const recoverPath = this.storagePath + ".recovering";
    const source = fs.existsSync(recoverPath)
      ? recoverPath
      : fs.existsSync(this.storagePath)
        ? this.storagePath
        : null;

    if (!source) return;

    try {
      const content = fs.readFileSync(source, "utf-8").trim();
      if (!content) {
        fs.unlinkSync(source);
        return;
      }

      let loaded = 0;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const batch: RequestEvent[] = JSON.parse(line);
          if (Array.isArray(batch)) {
            for (const event of batch) {
              if (this.buffer.length >= this.maxBufferSize) break;
              this.buffer.push(event);
              loaded++;
            }
          }
        } catch {
          // Skip corrupt lines
        }
        if (this.buffer.length >= this.maxBufferSize) break;
      }

      // Rename to .recovering instead of deleting — the file is only deleted
      // after the first successful flush (see doFlush). If the process crashes
      // before flushing, the next startup will find the .recovering file.
      if (source === this.storagePath) {
        fs.renameSync(this.storagePath, recoverPath);
      }
      this.recoveryPath = recoverPath;

      if (this.debug && loaded > 0) {
        console.log(`[apidash] Recovered ${loaded} events from disk`);
      }
    } catch (err) {
      if (this.debug) {
        console.error("[apidash] Failed to load persisted events:", (err as Error).message);
      }
      // Try to clean up corrupt file
      try {
        fs.unlinkSync(source);
      } catch {
        /* ignore */
      }
    }
  }

  /** Delete the recovery file after events have been successfully flushed. */
  private cleanupRecoveryFile(): void {
    if (this.recoveryPath) {
      try {
        fs.unlinkSync(this.recoveryPath);
      } catch {
        /* ignore */
      }
      this.recoveryPath = null;
    }
  }

  /** Register signal handlers for graceful shutdown with disk persistence.
   *  NOTE: The SDK no longer calls process.exit() — it only persists buffered
   *  events to disk and lets the host application control its own lifecycle. */
  private registerSignalHandlers(): void {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        this.shutdownSync();
      };
      process.on(signal, handler);
      this.signalHandlers.push({ signal, handler });
    }
  }

  /** Remove signal handlers to prevent leaked references across instances. */
  private removeSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];
  }

  /** Mask API key for safe logging: show first 8 chars only */
  private get maskedKey(): string {
    return this.apiKey.length > 8 ? this.apiKey.slice(0, 8) + "..." : this.apiKey;
  }

  private send(events: RequestEvent[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(events);
      const transport = this.useHttp ? http : https;

      // True total timeout covering DNS + TCP + TLS + response.
      // Unlike the socket idle `timeout` option (which only fires on
      // inactivity), AbortController aborts the entire request after the
      // deadline regardless of whether data is trickling in.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);

      const req = transport.request(
        {
          hostname: this.parsedUrl.hostname,
          port: this.parsedUrl.port || (this.useHttp ? 80 : 443),
          path: this.parsedUrl.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "x-api-key": this.apiKey,
          },
          agent: this.agent,
          signal: ac.signal,
        },
        (res) => {
          clearTimeout(timer);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            res.resume(); // drain body — nothing useful on success
            resolve();
          } else {
            // Read up to 1KB of response body to capture error details
            // (validation errors, rate limit info, etc.)
            const chunks: Buffer[] = [];
            let bodyLen = 0;
            res.on("data", (chunk: Buffer) => {
              if (bodyLen < 1024) {
                chunks.push(chunk);
                bodyLen += chunk.length;
              }
            });
            res.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf-8").slice(0, 1024);
              const retryAfter = res.headers["retry-after"];
              let message = `Ingestion API returned ${res.statusCode}`;
              if (body) message += `: ${body}`;
              if (retryAfter) message += ` (Retry-After: ${retryAfter})`;
              const err = new Error(message) as Error & { retryable: boolean; statusCode: number };
              err.retryable = RETRYABLE_STATUS_CODES.has(res.statusCode ?? 0);
              err.statusCode = res.statusCode ?? 0;
              reject(err);
            });
            res.on("error", () => {
              // Body read failed — reject with status code only
              const err = new Error(`Ingestion API returned ${res.statusCode}`) as Error & {
                retryable: boolean;
                statusCode: number;
              };
              err.retryable = RETRYABLE_STATUS_CODES.has(res.statusCode ?? 0);
              err.statusCode = res.statusCode ?? 0;
              reject(err);
            });
          }
        },
      );

      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }
}
