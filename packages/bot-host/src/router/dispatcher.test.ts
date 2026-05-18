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
  replies: Array<[string, string]>;
} {
  const replies: Array<[string, string]> = [];
  return {
    replies,
    async replyText(reply_to_message_id, content) {
      replies.push([reply_to_message_id, content]);
      return `om_reply_${reply_to_message_id.slice(-4)}`;
    },
    async shutdown() {},
  };
}

interface FakeTransport extends Transport {
  lastId: string | undefined;
  lastText: string | undefined;
  resolve: (fullReply: string) => void;
  reject: (err: unknown) => void;
}

function makeFakeTransport(): FakeTransport {
  const t: FakeTransport = {
    lastId: undefined,
    lastText: undefined,
    resolve: () => undefined,
    reject: () => undefined,
    async sendChat(id, text, _deviceId, _onChunk) {
      t.lastId = id;
      t.lastText = text;
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

    expect(transport.lastText).toBe("add a null check to login.ts");
    const task_id = transport.lastId!;

    const running = getTask(task_id)!;
    expect(running.status).toBe("running");

    transport.resolve("Here is the fix for handleLogin.");
    await p;

    const done = getTask(task_id)!;
    expect(done.status).toBe("done");
    expect(JSON.parse(done.result_json!).reply).toBe(
      "Here is the fix for handleLogin.",
    );
    expect(reply.replies).toHaveLength(1);
    expect(reply.replies[0]![1]).toBe("Here is the fix for handleLogin.");
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
    expect(reply.replies.at(-1)?.[1]).toContain("AI_Proxy not connected");
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
