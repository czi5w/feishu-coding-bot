import { ulid } from "ulid";
import type { Logger } from "pino";
import { logAudit } from "../storage/audit.js";
import {
  createTask,
  setResult,
  updateStatus,
} from "../storage/task-store.js";
import type { IncomingMessage } from "../feishu/handler.js";
import type { ReplyClient } from "../feishu/reply.js";
import { shortTaskId } from "../feishu/reply.js";

export interface Transport {
  sendChat(
    id: string,
    text: string,
    onChunk: (accumulated: string) => void,
  ): Promise<string>;
}

export interface DispatcherDeps {
  reply: ReplyClient;
  transport: Transport;
  logger?: Logger;
}

export interface Dispatcher {
  dispatch(msg: IncomingMessage): Promise<void>;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { reply, transport } = deps;
  const log = deps.logger;

  return {
    async dispatch(msg: IncomingMessage): Promise<void> {
      const task_id = ulid();

      createTask({
        task_id,
        chat_id: msg.chat_id,
        user_id: msg.user_id,
        message_id: msg.message_id,
        created_ts: msg.ts,
        status: "queued",
        request_json: JSON.stringify({
          text: msg.raw_text,
          chat_id: msg.chat_id,
          user_id: msg.user_id,
        }),
      });
      logAudit({
        ts: msg.ts,
        direction: "in",
        chat_id: msg.chat_id,
        user_id: msg.user_id,
        task_id,
        raw_text: msg.raw_text,
        extra: { event_id: msg.event_id },
      });

      updateStatus(task_id, "running");
      logAudit({
        ts: Math.floor(Date.now() / 1000),
        direction: "rpc_out",
        task_id,
        chat_id: msg.chat_id,
        extra: { method: "sendChat" },
      });

      try {
        const fullReply = await transport.sendChat(
          task_id,
          msg.raw_text,
          () => {},
        );

        setResult(task_id, JSON.stringify({ status: "success", reply: fullReply }));
        updateStatus(task_id, "done");

        await reply.replyText(msg.message_id, fullReply);

        logAudit({
          ts: Math.floor(Date.now() / 1000),
          direction: "out",
          task_id,
          chat_id: msg.chat_id,
          raw_text: fullReply,
        });
      } catch (err: unknown) {
        log?.error({ err, task_id }, "sendChat failed");
        updateStatus(task_id, "failed");
        const summary = err instanceof Error ? err.message : String(err);
        const content = `❌ failed: ${summary}`;

        await reply.replyText(msg.message_id, content);

        logAudit({
          ts: Math.floor(Date.now() / 1000),
          direction: "out",
          task_id,
          chat_id: msg.chat_id,
          raw_text: content,
        });
      }
    },
  };
}
