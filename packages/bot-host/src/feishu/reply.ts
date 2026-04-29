import type { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";

export function shortTaskId(task_id: string): string {
  return task_id.slice(-8).toLowerCase();
}

export interface ReplyClient {
  /** Send a reply message in the thread of the original message. */
  replyText(
    reply_to_message_id: string,
    content: string,
  ): Promise<string>;

  /** No-op shutdown for interface compat. */
  shutdown(): Promise<void>;
}

export function makeReplyClient(
  api: LarkClient,
  _throttleMs: number,
  log?: Logger,
): ReplyClient {
  return {
    async replyText(reply_to_message_id, content) {
      const res = await api.im.message.reply({
        path: { message_id: reply_to_message_id },
        data: {
          content: JSON.stringify({ text: content }),
          msg_type: "text",
          reply_in_thread: true,
        },
      });

      const msgId = res?.data?.message_id;
      if (!msgId) {
        log?.warn("lark message.reply returned no message_id");
      }
      return msgId ?? "";
    },

    async shutdown() {
      // nothing to flush
    },
  };
}
