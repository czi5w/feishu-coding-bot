#!/usr/bin/env node
// Fake agent-core — minimal WebSocket server that speaks the JSON-RPC 2.0
// protocol defined in packages/protocol, so bot-host can be driven end-to-end
// on a single machine without the real agent-core implementation (Phase D).
//
// Behavior:
//   - Listens on ws://AGENT_WS_HOST:AGENT_WS_PORT (defaults: 127.0.0.1:8765)
//   - Accepts exactly one active client (SPEC §8.1); rejects extras with 1013
//   - On `ping` notification        → replies with `pong`
//   - On `execute_task` request     → streams 3 fake progress events then
//                                     responds with a success ExecuteTaskResult
//   - On `cancel_task` request      → replies { cancelled: true }
//   - Unknown method                → JSON-RPC error -32601
//
// Not a substitute for real agent-core. Delete once Phase D lands.

import { WebSocketServer } from "ws";

const HOST = process.env.AGENT_WS_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AGENT_WS_PORT ?? 8765);

const server = new WebSocketServer({ host: HOST, port: PORT });
let activeClient = null;

server.on("listening", () => {
  log(`listening on ws://${HOST}:${PORT}`);
  log(`waiting for bot-host to connect…`);
});

server.on("error", (err) => {
  log(`server error: ${err.message}`);
  if (err.code === "EADDRINUSE") {
    log(`port ${PORT} already in use — is another process listening?`);
    process.exit(1);
  }
});

server.on("connection", (ws, req) => {
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

  if (activeClient && activeClient.readyState === activeClient.OPEN) {
    log(`rejecting extra connection from ${peer} (already have one)`);
    ws.close(1013, "another client already connected");
    return;
  }

  activeClient = ws;
  log(`client connected from ${peer}`);

  ws.on("message", (data) => {
    handleFrame(ws, data.toString("utf8")).catch((err) => {
      log(`handler error: ${err?.message ?? err}`);
    });
  });

  ws.on("close", (code, reason) => {
    log(`client disconnected code=${code} reason=${reason.toString() || "(none)"}`);
    if (activeClient === ws) activeClient = null;
  });

  ws.on("error", (err) => {
    log(`socket error: ${err.message}`);
  });
});

// ─── JSON-RPC routing ────────────────────────────────────────────────

async function handleFrame(ws, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    log(`parse error (dropped): ${text.slice(0, 120)}`);
    send(ws, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  if (msg.method === "ping") {
    send(ws, {
      jsonrpc: "2.0",
      method: "pong",
      params: { ts: Date.now() },
    });
    return;
  }

  if (msg.method === "execute_task") {
    log(`← execute_task id=${short(msg.id)} text="${truncate(msg.params?.text, 80)}"`);
    await runFakeTask(ws, msg);
    return;
  }

  if (msg.method === "cancel_task") {
    log(`← cancel_task task_id=${short(msg.params?.task_id)}`);
    send(ws, {
      jsonrpc: "2.0",
      id: msg.id,
      result: { cancelled: true },
    });
    return;
  }

  log(`unknown method: ${msg.method}`);
  send(ws, {
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code: -32601, message: `method not found: ${msg.method}` },
  });
}

// ─── Fake task runner ────────────────────────────────────────────────
// Emits planning → editing → testing → done, then a success response.
// Total wall time ~1.5 s, chosen so the 2 s reply throttle in bot-host
// still merges mid-task updates into one Feishu patch.

async function runFakeTask(ws, req) {
  const task_id = req.id;
  const t0 = Date.now();

  const steps = [
    { phase: "planning", chunk: `收到: ${truncate(req.params?.text, 60)}`, delay: 300 },
    { phase: "editing", chunk: "mock 编辑中…", delay: 500 },
    { phase: "testing", chunk: "mock 测试中…", delay: 400 },
  ];

  for (const step of steps) {
    await sleep(step.delay);
    if (ws.readyState !== ws.OPEN) return;
    sendProgress(ws, task_id, step.phase, step.chunk, false);
    log(`→ report_progress ${step.phase} (task=${short(task_id)})`);
  }

  await sleep(200);
  if (ws.readyState !== ws.OPEN) return;

  sendProgress(ws, task_id, "done", "mock 完成", true);

  const duration_ms = Date.now() - t0;
  const result = {
    status: "success",
    summary: "mock executor 模拟完成",
    branch: `ai/${short(task_id)}`,
    files_changed: ["mock/file.ts"],
    duration_ms,
  };
  send(ws, { jsonrpc: "2.0", id: task_id, result });
  log(`→ response success task=${short(task_id)} (${duration_ms}ms)`);
}

// ─── Small helpers ───────────────────────────────────────────────────

function sendProgress(ws, task_id, phase, chunk, is_final) {
  send(ws, {
    jsonrpc: "2.0",
    method: "report_progress",
    params: { task_id, phase, chunk, is_final },
  });
}

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(id) {
  if (typeof id !== "string") return String(id);
  return id.length > 8 ? id.slice(-8).toLowerCase() : id;
}

function truncate(str, max) {
  if (typeof str !== "string") return String(str ?? "");
  return str.length <= max ? str : str.slice(0, max) + "…";
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [fake-agent-core] ${msg}`);
}

// ─── Graceful shutdown ───────────────────────────────────────────────

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // Hard-exit safety net in case a socket refuses to close.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
