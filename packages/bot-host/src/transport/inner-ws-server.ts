import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Logger } from "pino";
import type { Transport } from "../router/dispatcher.js";

export interface InnerWsServerOptions {
  host: string;
  port: number;
  /** Max age of a pending request before it's rejected. Default 15 min. */
  pendingTimeoutMs?: number;
  /** Grace period for a new connection to send a register frame. Default 10s. */
  registerTimeoutMs?: number;
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
  /** device_id -> WebSocket for registered clients. */
  private readonly clients = new Map<string, WebSocket>();
  /** WebSocket -> device_id reverse lookup. */
  private readonly wsToDevice = new Map<WebSocket, string>();
  private readonly pending = new Map<string, PendingEntry>();
  private janitorTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(options: InnerWsServerOptions) {
    this.opts = {
      host: options.host,
      port: options.port,
      pendingTimeoutMs: options.pendingTimeoutMs ?? 15 * 60 * 1000,
      registerTimeoutMs: options.registerTimeoutMs ?? 10_000,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    };
  }

  getConnectedDevices(): string[] {
    return [...this.clients.keys()];
  }

  isDeviceConnected(deviceId: string): boolean {
    const ws = this.clients.get(deviceId);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
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
      this.opts.logger?.info({ remote: addr }, "new connection, awaiting register");

      let registered = false;

      const registerTimeout = setTimeout(() => {
        if (!registered) {
          this.opts.logger?.warn(
            { remote: addr },
            "connection did not register in time, closing",
          );
          ws.close(1008, "register timeout");
        }
      }, this.opts.registerTimeoutMs);
      registerTimeout.unref?.();

      const onFirstMessage = (data: RawData): void => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        let msg: { type?: string; device_id?: string };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          this.opts.logger?.warn({ text: text.slice(0, 200) }, "parse error on register frame");
          ws.close(1002, "invalid JSON");
          clearTimeout(registerTimeout);
          return;
        }

        if (msg.type !== "register" || !msg.device_id) {
          this.opts.logger?.warn(
            { type: msg.type },
            "first message must be register with device_id",
          );
          ws.close(1002, "expected register");
          clearTimeout(registerTimeout);
          return;
        }

        const deviceId = msg.device_id;
        registered = true;
        clearTimeout(registerTimeout);

        const old = this.clients.get(deviceId);
        if (old && old.readyState === WebSocket.OPEN) {
          this.opts.logger?.warn({ device_id: deviceId }, "replacing stale connection");
          this.wsToDevice.delete(old);
          old.close(1000, "replaced by new connection");
        }

        this.clients.set(deviceId, ws);
        this.wsToDevice.set(ws, deviceId);
        this.opts.logger?.info(
          { device_id: deviceId, remote: addr, total: this.clients.size },
          "AI_Proxy registered",
        );

        ws.removeListener("message", onFirstMessage);
        ws.on("message", (d) => this.onMessage(d));
      };

      ws.on("message", onFirstMessage);

      ws.on("close", (code, reason) => {
        clearTimeout(registerTimeout);
        const deviceId = this.wsToDevice.get(ws);
        this.wsToDevice.delete(ws);
        if (deviceId && this.clients.get(deviceId) === ws) {
          this.clients.delete(deviceId);
        }
        this.opts.logger?.warn(
          { code, reason: reason.toString(), device_id: deviceId ?? "unregistered" },
          "AI_Proxy disconnected",
        );
      });

      ws.on("error", (err) => {
        this.opts.logger?.warn({ err: err.message }, "AI_Proxy connection error");
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

    const closePromises: Promise<void>[] = [];
    for (const [, ws] of this.clients) {
      closePromises.push(
        new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close(1001, "server shutdown");
          setTimeout(() => {
            ws.terminate();
            resolve();
          }, 2000);
        }),
      );
    }
    this.clients.clear();
    this.wsToDevice.clear();
    await Promise.all(closePromises);

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
    deviceId: string,
    onChunk: (accumulated: string) => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.stopped) {
        reject(new Error("server is stopped"));
        return;
      }

      let ws: WebSocket | undefined;
      if (deviceId) {
        ws = this.clients.get(deviceId);
      } else {
        for (const [, client] of this.clients) {
          if (client.readyState === WebSocket.OPEN) {
            ws = client;
            break;
          }
        }
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(
          new Error(
            deviceId
              ? `device "${deviceId}" not connected`
              : "no AI_Proxy connected",
          ),
        );
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

      ws.send(frame, (err) => {
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
