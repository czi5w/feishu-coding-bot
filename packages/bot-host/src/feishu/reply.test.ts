import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeReplyClient, shortTaskId } from "./reply.js";

function makeFakeApi() {
  const replyCalls: Array<{ message_id: string; text: string }> = [];
  const patchCalls: Array<{ message_id: string; text: string }> = [];
  const api = {
    im: {
      message: {
        reply: vi.fn(async (args: {
          path: { message_id: string };
          data: { content: string; msg_type: string; reply_in_thread: boolean };
        }) => {
          const text = JSON.parse(args.data.content).text as string;
          replyCalls.push({ message_id: args.path.message_id, text });
          return { data: { message_id: `om_reply_${replyCalls.length}` } };
        }),
        patch: vi.fn(async (args: {
          path: { message_id: string };
          data: { content: string };
        }) => {
          const text = JSON.parse(args.data.content).text as string;
          patchCalls.push({ message_id: args.path.message_id, text });
          return { data: {} };
        }),
      },
    },
  };
  return { api, replyCalls, patchCalls };
}

describe("shortTaskId", () => {
  it("returns the lowercase last 8 chars", () => {
    expect(shortTaskId("01HN4XY00000ABCDEFGHIJKLMN")).toBe("ghijklmn");
  });
});

describe("ReplyClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("createInitialReply posts the queued marker and returns the new message_id", async () => {
    const { api, replyCalls } = makeFakeApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = makeReplyClient(api as any, 1000);
    const taskId = "01HN4XY0000000000000000042";
    const mid = await client.createInitialReply(taskId, "oc_1", "om_user_1");
    expect(mid).toBe("om_reply_1");
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]!.text).toContain("queued");
    expect(replyCalls[0]!.text).toContain(shortTaskId(taskId));
  });

  it("throttledUpdate coalesces rapid updates into one patch", async () => {
    const { api, patchCalls } = makeFakeApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = makeReplyClient(api as any, 1000);
    client.throttledUpdate("t1", "om_reply", "first");
    client.throttledUpdate("t1", "om_reply", "second");
    client.throttledUpdate("t1", "om_reply", "third");
    expect(patchCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    // Allow the queued patch promise to resolve.
    await vi.runAllTimersAsync();
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.text).toBe("third");
  });

  it("forceFlush fires immediately and cancels the timer", async () => {
    const { api, patchCalls } = makeFakeApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = makeReplyClient(api as any, 5000);
    client.throttledUpdate("t1", "om_reply", "pending");
    await client.forceFlush("t1");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.text).toBe("pending");
    // Timer should already be cleared — advancing time does not fire again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(patchCalls).toHaveLength(1);
  });

  it("forceFlush is a no-op when nothing is pending", async () => {
    const { api, patchCalls } = makeFakeApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = makeReplyClient(api as any, 1000);
    await client.forceFlush("unknown");
    expect(patchCalls).toHaveLength(0);
  });

  it("independent tasks throttle independently", async () => {
    const { api, patchCalls } = makeFakeApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = makeReplyClient(api as any, 1000);
    client.throttledUpdate("t1", "om_1", "t1-msg");
    client.throttledUpdate("t2", "om_2", "t2-msg");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();
    expect(patchCalls.sort((a, b) => a.text.localeCompare(b.text))).toEqual([
      { message_id: "om_1", text: "t1-msg" },
      { message_id: "om_2", text: "t2-msg" },
    ]);
  });
});
