import { describe, expect, it, vi } from "vitest";
import {
  parseIncomingEvent,
  type HandlerDeps,
  type LarkMessageReceiveEvent,
} from "./handler.js";

const BOT_OPEN_ID = "ou_bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function makeEvent(
  overrides: Partial<LarkMessageReceiveEvent> = {},
  messageOverrides: Partial<LarkMessageReceiveEvent["message"]> = {},
): LarkMessageReceiveEvent {
  return {
    event_id: "evt_001",
    ts: "1700000000",
    sender: {
      sender_id: { open_id: "ou_user_001" },
      sender_type: "user",
    },
    message: {
      message_id: "om_001",
      chat_id: "oc_group_001",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"></at> hello" }),
      create_time: "1700000000000",
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: BOT_OPEN_ID },
          name: "编程机器人",
        },
      ],
      ...messageOverrides,
    },
    ...overrides,
  };
}

function makeDeps(
  dedupHit = false,
): HandlerDeps & { markEventSeen: ReturnType<typeof vi.fn> } {
  return {
    bot_open_id: BOT_OPEN_ID,
    markEventSeen: vi.fn().mockReturnValue(!dedupHit),
  };
}

describe("parseIncomingEvent", () => {
  it("returns a normalized IncomingMessage for a valid @bot message", () => {
    const deps = makeDeps();
    const out = parseIncomingEvent(makeEvent(), deps);
    expect(out).not.toBeNull();
    expect(out?.event_id).toBe("evt_001");
    expect(out?.chat_id).toBe("oc_group_001");
    expect(out?.user_id).toBe("ou_user_001");
    expect(out?.message_id).toBe("om_001");
    expect(out?.ts).toBe(1_700_000_000);
    expect(out?.raw_text).toContain("hello");
    expect(deps.markEventSeen).toHaveBeenCalledWith("evt_001", 1_700_000_000);
  });

  it("returns null for p2p messages", () => {
    const deps = makeDeps();
    const ev = makeEvent({}, { chat_type: "p2p" });
    expect(parseIncomingEvent(ev, deps)).toBeNull();
    expect(deps.markEventSeen).not.toHaveBeenCalled();
  });

  it("returns null for non-text message types", () => {
    const deps = makeDeps();
    const ev = makeEvent({}, { message_type: "image" });
    expect(parseIncomingEvent(ev, deps)).toBeNull();
    expect(deps.markEventSeen).not.toHaveBeenCalled();
  });

  it("returns null when message does not @ the bot", () => {
    const deps = makeDeps();
    const ev = makeEvent(
      {},
      {
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_some_other_user" },
            name: "other",
          },
        ],
      },
    );
    expect(parseIncomingEvent(ev, deps)).toBeNull();
    expect(deps.markEventSeen).not.toHaveBeenCalled();
  });

  it("returns null when mentions is missing entirely", () => {
    const deps = makeDeps();
    const { mentions: _omit, ...rest } = makeEvent().message;
    const ev = { ...makeEvent(), message: rest };
    expect(parseIncomingEvent(ev, deps)).toBeNull();
  });

  it("returns null on duplicate event_id (dedup hit)", () => {
    const deps = makeDeps(true); // dedupHit = true → markEventSeen returns false
    expect(parseIncomingEvent(makeEvent(), deps)).toBeNull();
    expect(deps.markEventSeen).toHaveBeenCalledTimes(1);
  });

  it("returns null when sender.open_id is missing", () => {
    const deps = makeDeps();
    const ev = makeEvent();
    ev.sender = { sender_type: "user" };
    expect(parseIncomingEvent(ev, deps)).toBeNull();
  });

  it("returns null when event_id is missing", () => {
    const deps = makeDeps();
    const ev = makeEvent();
    delete ev.event_id;
    expect(parseIncomingEvent(ev, deps)).toBeNull();
    expect(deps.markEventSeen).not.toHaveBeenCalled();
  });

  it("returns null when content is not valid JSON", () => {
    const deps = makeDeps();
    const ev = makeEvent({}, { content: "{not json" });
    expect(parseIncomingEvent(ev, deps)).toBeNull();
  });

  it("falls back to message.create_time when ts is absent", () => {
    const deps = makeDeps();
    const ev = makeEvent({ ts: undefined });
    const out = parseIncomingEvent(ev, deps);
    expect(out?.ts).toBe(1_700_000_000); // 1700000000000 ms → 1700000000 s
  });
});
