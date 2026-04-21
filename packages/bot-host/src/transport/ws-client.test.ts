import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  BUSINESS_ERRORS,
  type ExecuteTaskRequest,
  type ReportProgressParams,
  type RpcError,
} from "@feishu-bot/protocol";
import { WsClient } from "./ws-client.js";

interface ServerFixture {
  wss: WebSocketServer;
  url: string;
  /** The most-recently-connected client socket. */
  currentSocket(): WebSocket | undefined;
  /** All raw frames received across all sockets, in arrival order. */
  received: string[];
  /** Wait for N parsed frames to have arrived (resolves when received.length >= n). */
  waitForFrames(n: number, timeoutMs?: number): Promise<void>;
  /** Wait for the server to observe `count` distinct client connections. */
  waitForConnections(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function startServer(): Promise<ServerFixture> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const addr = wss.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}`;

  const sockets: WebSocket[] = [];
  const received: string[] = [];
  let connectionCount = 0;
  const connectionWaiters: Array<{ n: number; resolve: () => void }> = [];
  const frameWaiters: Array<{ n: number; resolve: () => void }> = [];

  wss.on("connection", (ws) => {
    sockets.push(ws);
    connectionCount += 1;
    for (const w of connectionWaiters.slice()) {
      if (connectionCount >= w.n) {
        w.resolve();
        connectionWaiters.splice(connectionWaiters.indexOf(w), 1);
      }
    }
    ws.on("message", (data: RawData) => {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.concat(data as Buffer[]).toString("utf8");
      received.push(text);
      for (const w of frameWaiters.slice()) {
        if (received.length >= w.n) {
          w.resolve();
          frameWaiters.splice(frameWaiters.indexOf(w), 1);
        }
      }
    });
  });

  return {
    wss,
    url,
    received,
    currentSocket() {
      return sockets[sockets.length - 1];
    },
    waitForFrames(n, timeoutMs = 2000) {
      if (received.length >= n) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = { n, resolve };
        frameWaiters.push(waiter);
        setTimeout(() => {
          const idx = frameWaiters.indexOf(waiter);
          if (idx >= 0) {
            frameWaiters.splice(idx, 1);
            reject(
              new Error(
                `waitForFrames(${n}) timed out after ${timeoutMs}ms; got ${received.length}`,
              ),
            );
          }
        }, timeoutMs).unref?.();
      });
    },
    waitForConnections(count, timeoutMs = 2000) {
      if (connectionCount >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = { n: count, resolve };
        connectionWaiters.push(waiter);
        setTimeout(() => {
          const idx = connectionWaiters.indexOf(waiter);
          if (idx >= 0) {
            connectionWaiters.splice(idx, 1);
            reject(
              new Error(
                `waitForConnections(${count}) timed out after ${timeoutMs}ms; got ${connectionCount}`,
              ),
            );
          }
        }, timeoutMs).unref?.();
      });
    },
    async close() {
      for (const s of sockets) {
        try {
          s.terminate();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function makeReq(id: string, text = "hi"): ExecuteTaskRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "execute_task",
    params: {
      chat_id: "oc_1",
      user_id: "ou_1",
      user_name: "u",
      text,
      message_id: "om_1",
      ts: 1_700_000_000,
    },
  };
}

/** Wait until `pred()` returns true, polling every 5ms. */
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("WsClient", () => {
  let server: ServerFixture;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("connects, sends a request, and resolves on response", async () => {
    const client = new WsClient({
      url: server.url,
      reconnectMinMs: 50,
      reconnectMaxMs: 500,
      heartbeatMs: 10_000,
    });
    client.start();

    await server.waitForConnections(1);
    await waitUntil(() => client.getState() === "open");

    const req = makeReq("01HTEST0000000000000000001");
    const pending = client.sendRequest<{ status: string; summary: string; duration_ms: number }>(req);

    await server.waitForFrames(1);
    const sock = server.currentSocket()!;
    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { status: "success", summary: "ok", duration_ms: 100 },
      }),
    );

    const result = await pending;
    expect(result.status).toBe("success");
    expect(result.summary).toBe("ok");

    await client.stop();
  });

  it("routes report_progress notifications to the task's onProgress", async () => {
    const client = new WsClient({
      url: server.url,
      reconnectMinMs: 50,
      reconnectMaxMs: 500,
      heartbeatMs: 10_000,
    });
    client.start();
    await waitUntil(() => client.getState() === "open");

    const events: ReportProgressParams[] = [];
    const req = makeReq("01HTEST0000000000000000002");
    const pending = client.sendExecuteTask(req, (ev) => events.push(ev));

    await server.waitForFrames(1);
    const sock = server.currentSocket()!;
    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "report_progress",
        params: {
          task_id: req.id,
          phase: "planning",
          chunk: "analyzing",
          is_final: false,
        },
      }),
    );
    await waitUntil(() => events.length >= 1);
    expect(events[0]!.phase).toBe("planning");
    expect(events[0]!.chunk).toBe("analyzing");

    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          status: "success",
          summary: "done",
          duration_ms: 1000,
        },
      }),
    );
    const final = await pending;
    expect(final.status).toBe("success");

    await client.stop();
  });

  it("rejects pending with the RPC error on error response", async () => {
    const client = new WsClient({
      url: server.url,
      reconnectMinMs: 50,
      reconnectMaxMs: 500,
      heartbeatMs: 10_000,
    });
    client.start();
    await waitUntil(() => client.getState() === "open");

    const req = makeReq("01HTEST0000000000000000003");
    const pending = client.sendRequest(req);

    await server.waitForFrames(1);
    const sock = server.currentSocket()!;
    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: BUSINESS_ERRORS.EXECUTOR_FAILED,
          message: "cursor crashed",
        },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: BUSINESS_ERRORS.EXECUTOR_FAILED,
      message: "cursor crashed",
    });

    await client.stop();
  });

  it("queues requests while disconnected and flushes on (re)connect", async () => {
    // Don't start the server until after we've queued a request.
    await server.close();

    const client = new WsClient({
      url: `ws://127.0.0.1:1`, // intentionally bad, will fail fast
      reconnectMinMs: 30,
      reconnectMaxMs: 60,
      heartbeatMs: 10_000,
    });
    client.start();
    // Wait a beat — it will fail and enter backoff.
    await waitUntil(
      () => client.getState() === "backoff" || client.getState() === "connecting",
      1000,
    );

    const req = makeReq("01HTEST0000000000000000004");
    // Queued because not open. Promise is pending.
    const pending = client.sendRequest(req);

    // Flip to a new server on a known port. We need to stop the bad-URL client
    // and re-point it — so just verify the queue logic by using the running
    // client with a server at the *original* URL (re-open).
    server = await startServer();
    // The current client's URL won't magically change; let's stop it and prove
    // the queue behavior differently: start a fresh client with the good URL,
    // queue before connect completes.
    await client.stop();
    // The pending promise should have been rejected by stop().
    await expect(pending).rejects.toMatchObject({
      code: BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
    });

    const good = new WsClient({
      url: server.url,
      reconnectMinMs: 30,
      reconnectMaxMs: 200,
      heartbeatMs: 10_000,
    });
    // Queue before starting so the send happens via the outbound queue.
    const req2 = makeReq("01HTEST0000000000000000005");
    const p2 = good.sendRequest(req2);
    good.start();

    await server.waitForFrames(1);
    expect(JSON.parse(server.received[0]!).id).toBe(req2.id);
    const sock = server.currentSocket()!;
    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req2.id,
        result: { status: "success", summary: "queued-then-sent", duration_ms: 1 },
      }),
    );
    const res = await p2;
    expect(res).toMatchObject({ summary: "queued-then-sent" });

    await good.stop();
  });

  it("reconnects with backoff after the server drops the connection", async () => {
    const client = new WsClient({
      url: server.url,
      reconnectMinMs: 30,
      reconnectMaxMs: 200,
      heartbeatMs: 10_000,
    });
    client.start();
    await server.waitForConnections(1);
    await waitUntil(() => client.getState() === "open");

    // Kill the server-side socket; the client should reconnect.
    server.currentSocket()!.terminate();
    await server.waitForConnections(2, 3000);
    await waitUntil(() => client.getState() === "open", 3000);

    await client.stop();
  });

  it("rejects all pending with EXECUTOR_UNAVAILABLE on stop", async () => {
    const client = new WsClient({
      url: server.url,
      reconnectMinMs: 50,
      reconnectMaxMs: 500,
      heartbeatMs: 10_000,
    });
    client.start();
    await waitUntil(() => client.getState() === "open");

    const req = makeReq("01HTEST0000000000000000006");
    const pending = client.sendRequest(req);
    await server.waitForFrames(1);

    await client.stop();
    await expect(pending).rejects.toMatchObject({
      code: BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
    });
  });

  it("rejects overflow when the outbound queue is full", async () => {
    const client = new WsClient({
      url: `ws://127.0.0.1:1`, // nothing listening
      reconnectMinMs: 60_000,
      reconnectMaxMs: 60_000,
      heartbeatMs: 10_000,
      maxQueue: 2,
    });
    client.start();
    // Don't wait for open — it'll never happen. Just queue until full.
    const a = client.sendRequest(makeReq("01HTEST00000000000000000A"));
    const b = client.sendRequest(makeReq("01HTEST00000000000000000B"));
    const c = client.sendRequest(makeReq("01HTEST00000000000000000C"));

    await expect(c).rejects.toMatchObject({
      code: BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
    });

    await client.stop();
    // a and b reject on stop.
    await expect(a).rejects.toMatchObject({
      code: BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
    });
    await expect(b).rejects.toMatchObject({
      code: BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
    });
  });

  it("terminates the connection when the pong watchdog fires", async () => {
    const client = new WsClient({
      url: server.url,
      reconnectMinMs: 30,
      reconnectMaxMs: 200,
      // Short heartbeat + timeout so the watchdog trips quickly.
      heartbeatMs: 40,
      heartbeatTimeoutMs: 80,
    });
    client.start();
    await server.waitForConnections(1);
    await waitUntil(() => client.getState() === "open");

    // The test server never responds to pings → watchdog should fire,
    // triggering terminate → close → reconnect.
    await server.waitForConnections(2, 3000);
    await client.stop();
  });

  it("rejects duplicate request ids immediately", async () => {
    const client = new WsClient({
      url: server.url,
      reconnectMinMs: 50,
      reconnectMaxMs: 500,
      heartbeatMs: 10_000,
    });
    client.start();
    await waitUntil(() => client.getState() === "open");

    const req = makeReq("01HTEST0000000000000000099");
    const p1 = client.sendRequest(req);
    await server.waitForFrames(1);

    const dup = client.sendRequest(req);
    await expect(dup).rejects.toMatchObject({
      code: BUSINESS_ERRORS.EXECUTOR_UNAVAILABLE,
    });

    // Finish the first so stop() doesn't reject-it-at-us.
    const sock = server.currentSocket()!;
    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { status: "success", summary: "ok", duration_ms: 1 },
      }),
    );
    await p1;

    await client.stop();
  });
});

// Keep an unused-type import honest.
export type _RpcErrorPlaceholder = RpcError;
