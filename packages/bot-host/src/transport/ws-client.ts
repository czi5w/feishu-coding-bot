import WebSocket, { type RawData } from "ws";
import type { Logger } from "pino";
import {
  BUSINESS_ERRORS,
  inboundToBotSchema,
  makeError,
  type ExecuteTaskRequest,
  type ExecuteTaskResult,
  type OutboundRequest,
  type PingNotification,
  type ReportProgressParams,
  type RpcError,
} from "@feishu-bot/protocol";
// ─── State machine ──────────────────────────────────────────────────────

export type WsState =
  | "idle"
  | "connecting"
  | "open"
  | "backoff"
  | "stopped";

export interface WsClientOptions {
  url: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  heartbeatMs: number;
  /** Pong silence tolerated before treating connection as dead. Default 3× heartbeatMs. */
  heartbeatTimeoutMs?: number;
  /** Max age of a pending request before it's rejected. Default 15 min. */
  pendingTimeoutMs?: number;
  /** Outbound queue cap. Default 100. */
  maxQueue?: number;
  logger?: Logger;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (ev: ReportProgressParams) => void;
  created_ms: number;
}

export class WsClient {
  private readonly opts: Required<
    Omit<WsClientOptions, "logger">
  > & { logger?: Logger };

  private state: WsState = "idle";
  private ws: WebSocket | undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private janitorTimer: NodeJS.Timeout | undefined;
  private lastPongMs = 0;

  private readonly pending = new Map<string, PendingEntry>();
  private readonly outQueue: string[] = [];

  constructor(options: WsClientOptions) {
    this.opts = {
      url: options.url,
      reconnectMinMs: options.reconnectMinMs,
      reconnectMaxMs: options.reconnectMaxMs,
      heartbeatMs: options.heartbeatMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? options.heartbeatMs * 3,
      pendingTimeoutMs: options.pendingTimeoutMs ?? 15 * 60 * 1000,
      maxQueue: options.maxQueue ?? 100,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    };
  }

  getState(): WsState {
    return this.state;
  }

  /** Begin connection attempts. Idempotent — calling when not idle is a no-op. */
  start(): void {
    if (this.state !== "idle") return;
    this.connect();
    this.janitorTimer = setInterval(() => this.cleanupPending(), 30_000);
    this.janitorTimer.unref?.();
  }

  /** Tear down and reject all pending. */
  async stop(): Promise<void> {
    this.state = "stopped";
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    if (this.janitorTimer) {
      clearInterval(this.janitorTimer);
      this.janitorTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close(1000, "client shutdown");
      });
    } else {
      ws?.terminate();
    }
    const stopErr = makeError(
      BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
      "ws client stopped",
    );
    for (const [, entry] of this.pending) entry.reject(stopErr);
    this.pending.clear();
    this.outQueue.length = 0;
  }

  // ─── Transport (used by dispatcher) ───────────────────────────────────

  sendExecuteTask(
    req: ExecuteTaskRequest,
    onProgress: (ev: ReportProgressParams) => void,
  ): Promise<ExecuteTaskResult> {
    return this.sendRequest<ExecuteTaskResult>(req, onProgress);
  }

  // ─── Generic request (public for future use) ──────────────────────────

  sendRequest<R>(
    req: OutboundRequest,
    onProgress?: (ev: ReportProgressParams) => void,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (this.state === "stopped") {
        reject(
          makeError(
            BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
            "ws client is stopped",
          ),
        );
        return;
      }
      if (this.pending.has(req.id)) {
        reject(
          makeError(
            BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
            `duplicate request id ${req.id}`,
          ),
        );
        return;
      }

      const frame = JSON.stringify(req);
      const entry: PendingEntry = {
        resolve: resolve as (v: unknown) => void,
        reject,
        created_ms: Date.now(),
        ...(onProgress !== undefined ? { onProgress } : {}),
      };

      if (this.state === "open" && this.ws) {
        this.pending.set(req.id, entry);
        this.ws.send(frame);
        return;
      }

      // Queue until we reconnect.
      if (this.outQueue.length >= this.opts.maxQueue) {
        reject(
          makeError(
            BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
            `outbound queue full (${this.opts.maxQueue})`,
          ),
        );
        return;
      }
      this.pending.set(req.id, entry);
      this.outQueue.push(frame);
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private connect(): void {
    this.state = "connecting";
    this.opts.logger?.info(
      { url: this.opts.url, attempt: this.reconnectAttempts + 1 },
      "ws connecting",
    );
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => this.onOpen());
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", (code, reason) => this.onClose(code, reason.toString()));
    ws.on("error", (err) => this.onError(err));
  }

  private onOpen(): void {
    this.state = "open";
    this.reconnectAttempts = 0;
    this.lastPongMs = Date.now();
    this.opts.logger?.info({ url: this.opts.url }, "ws open");

    // Flush outbound queue.
    while (this.outQueue.length > 0 && this.ws) {
      const frame = this.outQueue.shift();
      if (frame !== undefined) this.ws.send(frame);
    }

    this.startHeartbeat();
  }

  private onClose(code: number, reason: string): void {
    this.clearHeartbeatTimer();
    this.ws = undefined;
    if (this.state === "stopped") return;

    this.opts.logger?.warn({ code, reason }, "ws closed, scheduling reconnect");
    this.state = "backoff";
    const delay = this.computeBackoff();
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private onError(err: Error): void {
    // `close` will fire after error; nothing to do besides log.
    this.opts.logger?.warn({ err: err.message }, "ws error");
  }

  private onMessage(data: RawData): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.opts.logger?.warn({ text: text.slice(0, 200) }, "ws parse error");
      return;
    }

    const result = inboundToBotSchema.safeParse(raw);
    if (!result.success) {
      this.opts.logger?.warn(
        { issues: result.error.issues.slice(0, 3) },
        "ws inbound failed schema validation",
      );
      return;
    }

    const frame = result.data;

    // report_progress / pong notifications have `method`. Responses do not.
    if ("method" in frame) {
      if (frame.method === "report_progress") {
        const params = frame.params;
        const entry = this.pending.get(params.task_id);
        entry?.onProgress?.(params);
      } else if (frame.method === "pong") {
        this.lastPongMs = Date.now();
      }
      return;
    }

    // Response: has `id` and either `result` or `error`.
    if (frame.id === null) {
      // Server-side parse error with no id to route to — log and drop.
      this.opts.logger?.warn({ frame }, "ws inbound error with null id");
      return;
    }
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    if ("result" in frame) {
      entry.resolve(frame.result);
    } else {
      const err: RpcError = makeError(
        frame.error.code as RpcError["code"],
        frame.error.message,
        frame.error.data,
      );
      entry.reject(err);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // If we haven't heard a pong in heartbeatTimeoutMs, declare dead.
      if (Date.now() - this.lastPongMs > this.opts.heartbeatTimeoutMs) {
        this.opts.logger?.warn(
          { since_ms: Date.now() - this.lastPongMs },
          "pong watchdog fired, terminating connection",
        );
        this.ws.terminate();
        return;
      }
      const ping: PingNotification = {
        jsonrpc: "2.0",
        method: "ping",
        params: { ts: Date.now() },
      };
      this.ws.send(JSON.stringify(ping));
    }, this.opts.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private computeBackoff(): number {
    const { reconnectMinMs, reconnectMaxMs } = this.opts;
    const delay = Math.min(
      reconnectMinMs * 2 ** this.reconnectAttempts,
      reconnectMaxMs,
    );
    return delay;
  }

  private cleanupPending(): void {
    const cutoff = Date.now() - this.opts.pendingTimeoutMs;
    for (const [id, entry] of this.pending) {
      if (entry.created_ms < cutoff) {
        this.pending.delete(id);
        entry.reject(
          makeError(
            BUSINESS_ERRORS.EXECUTOR_TIMEOUT,
            `pending request ${id} exceeded ${this.opts.pendingTimeoutMs}ms`,
          ),
        );
      }
    }
  }
}
