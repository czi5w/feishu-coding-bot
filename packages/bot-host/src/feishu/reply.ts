import type { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";

/**
 * Format the 8-char task_id suffix used in user-visible messages.
 * ULID's last 8 chars are the low-entropy tail — good enough as a human tag.
 */
export function shortTaskId(task_id: string): string {
  return task_id.slice(-8).toLowerCase();
}

export interface ReplyClient {
  /**
   * Create the initial "queued" message as a thread reply to the user's
   * original message. Returns the new message's message_id so the caller can
   * persist it for subsequent patches.
   */
  createInitialReply(
    task_id: string,
    chat_id: string,
    reply_to_message_id: string,
  ): Promise<string>;

  /**
   * Buffer a content update for this task. The actual lark API call fires at
   * most once per throttleMs. Subsequent calls before the timer fires
   * overwrite the pending content — only the latest wins.
   */
  throttledUpdate(
    task_id: string,
    reply_message_id: string,
    content: string,
  ): void;

  /**
   * Cancel any pending timer and flush the latest buffered content
   * immediately. Safe to call multiple times and after throttledUpdate has
   * already fired naturally.
   */
  forceFlush(task_id: string): Promise<void>;

  /** Cancel all pending timers — used during shutdown. */
  shutdown(): Promise<void>;
}

interface PendingUpdate {
  reply_message_id: string;
  content: string;
  timer: NodeJS.Timeout;
}

export function makeReplyClient(
  api: LarkClient,
  throttleMs: number,
  log?: Logger,
): ReplyClient {
  const pending = new Map<string, PendingUpdate>();

  async function patchMessage(
    reply_message_id: string,
    content: string,
  ): Promise<void> {
    try {
      await api.im.message.patch({
        path: { message_id: reply_message_id },
        data: { content: JSON.stringify({ text: content }) },
      });
    } catch (err: unknown) {
      log?.warn({ err, reply_message_id }, "lark message.patch failed");
    }
  }

  async function flush(task_id: string): Promise<void> {
    const entry = pending.get(task_id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(task_id);
    await patchMessage(entry.reply_message_id, entry.content);
  }

  return {
    async createInitialReply(task_id, chat_id, reply_to_message_id) {
      const text = `🟡 [task_${shortTaskId(task_id)}] queued`;
      const res = await api.im.message.reply({
        path: { message_id: reply_to_message_id },
        data: {
          content: JSON.stringify({ text }),
          msg_type: "text",
          reply_in_thread: true,
        },
      });

      const msgId = res?.data?.message_id;
      if (!msgId) {
        throw new Error(
          `lark message.reply returned no message_id (chat_id=${chat_id})`,
        );
      }
      return msgId;
    },

    throttledUpdate(task_id, reply_message_id, content) {
      const existing = pending.get(task_id);
      if (existing) {
        // Overwrite — timer keeps ticking, latest content wins.
        existing.reply_message_id = reply_message_id;
        existing.content = content;
        return;
      }
      const timer = setTimeout(() => {
        void flush(task_id);
      }, throttleMs);
      // Don't keep the event loop alive on this alone.
      timer.unref?.();
      pending.set(task_id, { reply_message_id, content, timer });
    },

    forceFlush: flush,

    async shutdown() {
      for (const [task_id, entry] of pending.entries()) {
        clearTimeout(entry.timer);
        pending.delete(task_id);
        // Best-effort flush; don't block shutdown on lark errors.
        await patchMessage(entry.reply_message_id, entry.content).catch(
          () => undefined,
        );
      }
    },
  };
}
