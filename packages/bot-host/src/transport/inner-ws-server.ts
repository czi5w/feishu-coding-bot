import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Logger } from "pino";
import type { Transport } from "../router/dispatcher.js";

export interface InnerWsServerOptions {
  host: string;
  port: number;
  /** Max age of a pending request before it's rejected. Default 15 min. */
  pendingTimeoutMs?: number;
  logger?: Logger;
}

interface PendingEntry {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
  onChunk: (accumulated: string) => void;
  accumulated: string;
  created_ms: number;
}

export class InnerWsServer implements Transport {
  private readonly opts: Required<Omit<InnerWsServerOptions, "logger">> & {
    logger?: Logger;
  };
  private wss: WebSocketServer | undefined;
  private activeClient: WebSocket | undefined;
  private readonly pending = new Map<string, PendingEntry>();
  private janitorTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(options: InnerWsServerOptions) {
    this.opts = {
      host: options.host,
      port: options.port,
      pendingTimeoutMs: options.pendingTimeoutMs ?? 15 * 60 * 1000,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    };
  }

  isConnected(): boolean {
    return (
      this.activeClient !== undefined &&
      this.activeClient.readyState === WebSocket.OPEN
    );
  }

  start(): void {
    if (this.wss) return;

    this.wss = new WebSocketServer({
      host: this.opts.host,
      port: this.opts.port,
    });

    this.wss.on("listening", () => {
      this.opts.logger?.info(
        { host: this.opts.host, port: this.opts.port },
        "inner WS server listening",
      );
    });

    this.wss.on("error", (err) => {
      this.opts.logger?.error({ err: err.message }, "inner WS server error");
    });

    this.wss.on("connection", (ws, req) => {
      const addr = req.socket.remoteAddress ?? "unknown";
      if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
        this.opts.logger?.warn(
          { remote: addr },
          "rejecting new connection — one client already active",
        );
        ws.close(1013, "try again later");
        return;
      }

      this.opts.logger?.info({ remote: addr }, "AI_Proxy connected");
      this.activeClient = ws;

      ws.on("message", (data) => this.onMessage(data));
      ws.on("close", (code, reason) => {
        this.opts.logger?.warn(
          { code, reason: reason.toString() },
          "AI_Proxy disconnected",
        );
        if (this.activeClient === ws) {
          this.activeClient = undefined;
        }
      });
      ws.on("error", (err) => {
        this.opts.logger?.warn(
          { err: err.message },
          "AI_Proxy connection error",
        );
      });
    });

    this.janitorTimer = setInterval(() => this.cleanupPending(), 30_000);
    this.janitorTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.janitorTimer) {
      clearInterval(this.janitorTimer);
      this.janitorTimer = undefined;
    }

    for (const [, entry] of this.pending) {
      entry.reject(new Error("server shutting down"));
    }
    this.pending.clear();

    if (this.activeClient) {
      const ws = this.activeClient;
      this.activeClient = undefined;
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close(1001, "server shutdown");
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, 2000);
      });
    }

    if (this.wss) {
      const server = this.wss;
      this.wss = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  // ─── Transport interface ────────────────────────────────────────

  sendChat(
    id: string,
    text: string,
    onChunk: (accumulated: string) => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.stopped) {
        reject(new Error("server is stopped"));
        return;
      }
      if (!this.isConnected()) {
        reject(new Error("AI_Proxy not connected"));
        return;
      }
      if (this.pending.has(id)) {
        reject(new Error(`duplicate request id ${id}`));
        return;
      }

      const frame = JSON.stringify({
        type: "request",
        id,
        messages: [{ role: "user", content: text }],
      });

      this.pending.set(id, {
        resolve,
        reject,
        onChunk,
        accumulated: "",
        created_ms: Date.now(),
      });

      this.activeClient!.send(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error(`send failed: ${err.message}`));
        }
      });
    });
  }

  // ─── Internals ──────────────────────────────────────────────────

  private onMessage(data: RawData): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    let msg: { type?: string; id?: string; content?: string; message?: string };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      this.opts.logger?.warn(
        { text: text.slice(0, 200) },
        "inner WS parse error",
      );
      return;
    }

    const type = msg.type ?? "";
    const id = msg.id ?? "";

    if (type === "chunk") {
      const entry = this.pending.get(id);
      if (!entry) return;
      entry.accumulated += msg.content ?? "";
      entry.onChunk(entry.accumulated);
      return;
    }

    if (type === "done") {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      entry.resolve(entry.accumulated);
      return;
    }

    if (type === "error") {
      const entry = this.pending.get(id);
      if (!entry) {
        this.opts.logger?.warn({ id, message: msg.message }, "orphan error");
        return;
      }
      this.pending.delete(id);
      entry.reject(new Error(msg.message ?? "AI_Proxy error"));
      return;
    }

    this.opts.logger?.debug({ type }, "ignoring unknown message type");
  }

  private cleanupPending(): void {
    const cutoff = Date.now() - this.opts.pendingTimeoutMs;
    for (const [id, entry] of this.pending) {
      if (entry.created_ms < cutoff) {
        this.pending.delete(id);
        entry.reject(
          new Error(`pending request ${id} exceeded ${this.opts.pendingTimeoutMs}ms`),
        );
      }
    }
  }
}
