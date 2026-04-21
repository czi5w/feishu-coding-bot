import type { Logger } from "pino";

/** Shape of the P2ImMessageReceiveV1 event payload we care about. */
export interface LarkMessageReceiveEvent {
  event_id?: string;
  create_time?: string;
  ts?: string;
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
      tenant_key?: string;
    }>;
  };
}

/** Normalized event handed to downstream routing. */
export interface IncomingMessage {
  event_id: string;
  chat_id: string;
  user_id: string;
  user_name: string;
  message_id: string;
  raw_text: string;
  ts: number; // unix seconds
}

export interface HandlerDeps {
  /** The bot's open_id — mentions must reference this id. */
  bot_open_id: string;
  /** Returns true if the event_id is new (caller should proceed). */
  markEventSeen: (event_id: string, ts: number) => boolean;
  logger?: Logger;
}

/**
 * Inspect an inbound Feishu event and return a normalized IncomingMessage,
 * or `null` if the event should be ignored for any of the documented reasons:
 *   - not a group chat
 *   - not a text message (later phases may relax this)
 *   - missing event_id
 *   - message does not @ the bot
 *   - event_id already seen (duplicate delivery)
 *
 * No Feishu API calls; pure transform + one dedup DB write via the injected hook.
 */
export function parseIncomingEvent(
  ev: LarkMessageReceiveEvent,
  deps: HandlerDeps,
): IncomingMessage | null {
  const log = deps.logger;
  const { message, sender } = ev;

  if (!ev.event_id) {
    log?.warn({ message_id: message?.message_id }, "event missing event_id");
    return null;
  }
  if (message.chat_type !== "group") {
    log?.debug({ chat_type: message.chat_type }, "skip non-group message");
    return null;
  }
  if (message.message_type !== "text") {
    log?.debug(
      { message_type: message.message_type },
      "skip non-text message",
    );
    return null;
  }

  const mentionsBot = (message.mentions ?? []).some(
    (m) => m.id.open_id === deps.bot_open_id,
  );
  if (!mentionsBot) {
    log?.debug({ chat_id: message.chat_id }, "skip message without @bot");
    return null;
  }

  // Parse text payload. content is a JSON string like {"text": "..."}.
  let raw_text = "";
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "text" in parsed &&
      typeof (parsed as { text: unknown }).text === "string"
    ) {
      raw_text = (parsed as { text: string }).text;
    }
  } catch {
    log?.warn({ content: message.content }, "failed to parse message.content");
    return null;
  }

  // Deterministic event timestamp: prefer ts (unix seconds string), fall back
  // to message.create_time (unix millis string), finally Date.now().
  const ts = pickEventTs(ev);

  // Dedup — atomic insert-or-ignore.
  const fresh = deps.markEventSeen(ev.event_id, ts);
  if (!fresh) {
    log?.debug({ event_id: ev.event_id }, "duplicate event suppressed");
    return null;
  }

  const user_id = sender.sender_id?.open_id ?? "";
  if (!user_id) {
    log?.warn({ event_id: ev.event_id }, "event missing sender open_id");
    return null;
  }

  // lark receive event has no sender name; we intentionally leave user_name
  // empty. Callers that need a display name can resolve it via contact API.
  return {
    event_id: ev.event_id,
    chat_id: message.chat_id,
    user_id,
    user_name: "",
    message_id: message.message_id,
    raw_text,
    ts,
  };
}

function pickEventTs(ev: LarkMessageReceiveEvent): number {
  // `ts` is documented as "seconds" string; `create_time` on message is ms string.
  const tsStr = ev.ts;
  if (tsStr && /^\d+$/.test(tsStr)) {
    const n = Number(tsStr);
    if (n > 0) return n;
  }
  const ct = ev.message.create_time;
  if (ct && /^\d+$/.test(ct)) {
    const n = Number(ct);
    if (n > 0) return Math.floor(n / 1000);
  }
  return Math.floor(Date.now() / 1000);
}
