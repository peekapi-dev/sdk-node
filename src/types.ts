export interface PeekApiOptions {
  apiKey: string;
  /** Override the ingestion endpoint. Defaults to the URL baked in at build time. */
  endpoint?: string;
  flushInterval?: number;
  batchSize?: number;
  maxBufferSize?: number;
  debug?: boolean;
  identifyConsumer?: (req: any) => string | undefined;
  /** TLS options passed to https.Agent (e.g. { ca, rejectUnauthorized }) */
  tlsOptions?: {
    ca?: string | Buffer | Array<string | Buffer>;
    cert?: string | Buffer;
    key?: string | Buffer;
    rejectUnauthorized?: boolean;
  };
  /** Include sorted query string in tracked path (e.g. /users?role=admin).
   *  NOTE: increases DB usage — each unique path+query creates a separate endpoint row. */
  collectQueryString?: boolean;
  /** Path to persist undelivered events. Default: os.tmpdir() + '/peekapi-events-<hash>.jsonl' */
  storagePath?: string;
  /** Max bytes for the fallback storage file. Default: 5MB (5_242_880) */
  maxStorageBytes?: number;
  /** Max bytes per serialized event. Events exceeding this have their metadata stripped.
   *  If still too large after stripping, the event is dropped. Default: 65,536 (64KB) */
  maxEventBytes?: number;
  /** Optional callback invoked when a background flush fails (network error,
   *  non-retryable status, etc.). Called from the timer and auto-flush paths.
   *  Must not throw — exceptions are swallowed to protect the host app. */
  onError?: (err: Error) => void;
}

export interface RequestEvent {
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  request_size: number;
  response_size: number;
  consumer_id?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
