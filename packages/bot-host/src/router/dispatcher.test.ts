import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExecuteTaskRequest,
  ExecuteTaskResult,
  ReportProgressParams,
} from "@feishu-bot/protocol";
import { _resetDbForTest, _setDbForTest, openDatabase, type Db } from "../storage/db.js";
import { getTask } from "../storage/task-store.js";
import type { IncomingMessage } from "../feishu/handler.js";
import type { ReplyClient } from "../feishu/reply.js";
import {
  createDispatcher,
  formatFinalMessage,
  formatProgressMessage,
  type Transport,
} from "./dispatcher.js";

function makeFakeReply(): ReplyClient & {
  created: Array<[string, string, string]>;
  updates: Array<[string, string, string]>;
  flushed: string[];
} {
  const created: Array<[string, string, string]> = [];
  const updates: Array<[string, string, string]> = [];
  const flushed: string[] = [];
  return {
    created,
    updates,
    flushed,
    async createInitialReply(task_id, chat_id, reply_to_message_id) {
      created.push([task_id, chat_id, reply_to_message_id]);
      return `om_reply_${task_id.slice(-4)}`;
    },
    throttledUpdate(task_id, reply_message_id, content) {
      updates.push([task_id, reply_message_id, content]);
    },
    async forceFlush(task_id) {
      flushed.push(task_id);
    },
    async shutdown() {
      // noop
    },
  };
}

interface FakeTransport extends Transport {
  lastRequest: ExecuteTaskRequest | undefined;
  /** Drive progress events + the final result from the test body. */
  emitProgress: (ev: ReportProgressParams) => void;
  resolve: (r: ExecuteTaskResult) => void;
  reject: (err: unknown) => void;
}

function makeFakeTransport(): FakeTransport {
  const t: FakeTransport = {
    lastRequest: undefined,
    emitProgress: () => undefined,
    resolve: () => undefined,
    reject: () => undefined,
    async sendExecuteTask(req, onProgress) {
      t.lastRequest = req;
      t.emitProgress = onProgress;
      return new Promise<ExecuteTaskResult>((resolve, reject) => {
        t.resolve = resolve;
        t.reject = reject;
      });
    },
  };
  return t;
}

const sampleIncoming: IncomingMessage = {
  event_id: "evt_1",
  chat_id: "oc_1",
  user_id: "ou_user",
  user_name: "",
  message_id: "om_user_1",
  raw_text: "add a null check to login.ts",
  ts: 1_700_000_000,
};

describe("dispatcher", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
    _setDbForTest(db);
  });
  afterEach(() => {
    db.close();
    _resetDbForTest();
  });

  it("drives a task from queued → running → done on success", async () => {
    const reply = makeFakeReply();
    const transport = makeFakeTransport();
    const dispatcher = createDispatcher({ reply, transport });

    const p = dispatcher.dispatch(sampleIncoming);

    // Yield microtasks so dispatch can reach sendExecuteTask.
    await Promise.resolve();
    await Promise.resolve();

    expect(reply.created).toHaveLength(1);
    expect(transport.lastRequest?.method).toBe("execute_task");
    const task_id = transport.lastRequest!.id;

    // Task should now be running with a persisted reply_message_id.
    const running = getTask(task_id)!;
    expect(running.status).toBe("running");
    expect(running.reply_message_id).toBe(`om_reply_${task_id.slice(-4)}`);

    // Emit one progress event — dispatcher should throttle-push formatted text.
    transport.emitProgress({
      task_id,
      phase: "editing",
      chunk: "正在改 handleLogin",
      is_final: false,
    });
    expect(reply.updates.at(-1)?.[2]).toContain("editing");

    // Finalize.
    transport.resolve({
      status: "success",
      summary: "fixed",
      branch: "ai/12345678",
      files_changed: ["src/login.ts"],
      duration_ms: 48_000,
    });
    await p;

    const done = getTask(task_id)!;
    expect(done.status).toBe("done");
    expect(JSON.parse(done.result_json!).summary).toBe("fixed");
    expect(reply.flushed).toContain(task_id);
    // Last update to reply must be the final-formatted message.
    expect(reply.updates.at(-1)?.[2]).toContain("✅");
    expect(reply.updates.at(-1)?.[2]).toContain("ai/12345678");
  });

  it("marks task failed when transport rejects", async () => {
    const reply = makeFakeReply();
    const transport = makeFakeTransport();
    const dispatcher = createDispatcher({ reply, transport });

    const p = dispatcher.dispatch(sampleIncoming);
    await Promise.resolve();
    await Promise.resolve();
    const task_id = transport.lastRequest!.id;

    transport.reject(new Error("agent unreachable"));
    await p;

    const rec = getTask(task_id)!;
    expect(rec.status).toBe("failed");
    expect(reply.flushed).toContain(task_id);
    expect(reply.updates.at(-1)?.[2]).toContain("agent unreachable");
  });

  it("marks task failed and skips transport when initial reply fails", async () => {
    const reply = makeFakeReply();
    reply.createInitialReply = vi
      .fn()
      .mockRejectedValue(new Error("lark down"));
    const transport = makeFakeTransport();
    const sendSpy = vi.spyOn(transport, "sendExecuteTask");
    const dispatcher = createDispatcher({ reply, transport });

    await dispatcher.dispatch(sampleIncoming);

    expect(sendSpy).not.toHaveBeenCalled();
    // The created task has transitioned to failed; we don't know its exact
    // task_id (ULID), so look it up by the deterministic chat_id.
    const rows = db
      .prepare(`SELECT task_id, status FROM task_state`)
      .all() as { task_id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
  });

  it("writes audit log entries for in / rpc_out / rpc_in / out", async () => {
    const reply = makeFakeReply();
    const transport = makeFakeTransport();
    const dispatcher = createDispatcher({ reply, transport });
    const p = dispatcher.dispatch(sampleIncoming);
    await Promise.resolve();
    await Promise.resolve();
    const task_id = transport.lastRequest!.id;
    transport.emitProgress({
      task_id,
      phase: "testing",
      chunk: "",
      is_final: false,
    });
    transport.resolve({
      status: "success",
      summary: "ok",
      duration_ms: 1000,
    });
    await p;

    const directions = (
      db
        .prepare(`SELECT direction FROM audit_log ORDER BY id`)
        .all() as { direction: string }[]
    ).map((r) => r.direction);
    expect(directions).toContain("in");
    expect(directions).toContain("rpc_out");
    expect(directions).toContain("rpc_in");
    expect(directions).toContain("out");
  });
});

describe("format helpers", () => {
  it("formatProgressMessage emits phase header + indented body", () => {
    const out = formatProgressMessage(
      "01HN4XY0000000000000000042",
      "planning",
      "analyzing login flow",
    );
    expect(out).toContain("planning");
    expect(out).toContain("→ analyzing login flow");
  });

  it("formatFinalMessage uses ✅ for success and includes branch", () => {
    const out = formatFinalMessage("01HN4XY0000000000000000042", {
      status: "success",
      summary: "done",
      branch: "ai/abcdef12",
      files_changed: ["a.ts", "b.ts"],
      duration_ms: 12_000,
    });
    expect(out.startsWith("✅")).toBe(true);
    expect(out).toContain("ai/abcdef12");
    expect(out).toContain("a.ts, b.ts");
  });

  it("formatFinalMessage uses ❌ for failure", () => {
    const out = formatFinalMessage("01HN4XY0000000000000000042", {
      status: "failure",
      summary: "cursor crashed",
      duration_ms: 5_000,
    });
    expect(out.startsWith("❌")).toBe(true);
  });
});
