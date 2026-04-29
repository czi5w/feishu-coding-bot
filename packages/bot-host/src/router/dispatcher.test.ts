import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDbForTest, _setDbForTest, openDatabase, type Db } from "../storage/db.js";
import { getTask } from "../storage/task-store.js";
import type { IncomingMessage } from "../feishu/handler.js";
import type { ReplyClient } from "../feishu/reply.js";
import {
  createDispatcher,
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
  lastId: string | undefined;
  lastText: string | undefined;
  emitChunk: (accumulated: string) => void;
  resolve: (fullReply: string) => void;
  reject: (err: unknown) => void;
}

function makeFakeTransport(): FakeTransport {
  const t: FakeTransport = {
    lastId: undefined,
    lastText: undefined,
    emitChunk: () => undefined,
    resolve: () => undefined,
    reject: () => undefined,
    async sendChat(id, text, onChunk) {
      t.lastId = id;
      t.lastText = text;
      t.emitChunk = onChunk;
      return new Promise<string>((resolve, reject) => {
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

    await Promise.resolve();
    await Promise.resolve();

    expect(reply.created).toHaveLength(1);
    expect(transport.lastText).toBe("add a null check to login.ts");
    const task_id = transport.lastId!;

    const running = getTask(task_id)!;
    expect(running.status).toBe("running");
    expect(running.reply_message_id).toBe(`om_reply_${task_id.slice(-4)}`);

    transport.emitChunk("AI is thinking...");
    expect(reply.updates.at(-1)?.[2]).toContain("AI is thinking...");

    transport.resolve("Here is the fix for handleLogin.");
    await p;

    const done = getTask(task_id)!;
    expect(done.status).toBe("done");
    expect(JSON.parse(done.result_json!).reply).toBe(
      "Here is the fix for handleLogin.",
    );
    expect(reply.flushed).toContain(task_id);
    expect(reply.updates.at(-1)?.[2]).toBe(
      "Here is the fix for handleLogin.",
    );
  });

  it("marks task failed when transport rejects", async () => {
    const reply = makeFakeReply();
    const transport = makeFakeTransport();
    const dispatcher = createDispatcher({ reply, transport });

    const p = dispatcher.dispatch(sampleIncoming);
    await Promise.resolve();
    await Promise.resolve();
    const task_id = transport.lastId!;

    transport.reject(new Error("AI_Proxy not connected"));
    await p;

    const rec = getTask(task_id)!;
    expect(rec.status).toBe("failed");
    expect(reply.flushed).toContain(task_id);
    expect(reply.updates.at(-1)?.[2]).toContain("AI_Proxy not connected");
  });

  it("marks task failed and skips transport when initial reply fails", async () => {
    const reply = makeFakeReply();
    reply.createInitialReply = vi
      .fn()
      .mockRejectedValue(new Error("lark down"));
    const transport = makeFakeTransport();
    const sendSpy = vi.spyOn(transport, "sendChat");
    const dispatcher = createDispatcher({ reply, transport });

    await dispatcher.dispatch(sampleIncoming);

    expect(sendSpy).not.toHaveBeenCalled();
    const rows = db
      .prepare(`SELECT task_id, status FROM task_state`)
      .all() as { task_id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
  });

  it("writes audit log entries for in / rpc_out / out", async () => {
    const reply = makeFakeReply();
    const transport = makeFakeTransport();
    const dispatcher = createDispatcher({ reply, transport });
    const p = dispatcher.dispatch(sampleIncoming);
    await Promise.resolve();
    await Promise.resolve();

    transport.resolve("done");
    await p;

    const directions = (
      db
        .prepare(`SELECT direction FROM audit_log ORDER BY id`)
        .all() as { direction: string }[]
    ).map((r) => r.direction);
    expect(directions).toContain("in");
    expect(directions).toContain("rpc_out");
    expect(directions).toContain("out");
  });
});
