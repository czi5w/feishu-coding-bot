import { ulid } from "ulid";
import type { Logger } from "pino";
import { logAudit } from "../storage/audit.js";
import {
  createTask,
  setReplyMessageId,
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

      let reply_message_id: string;
      try {
        reply_message_id = await reply.createInitialReply(
          task_id,
          msg.chat_id,
          msg.message_id,
        );
      } catch (err: unknown) {
        log?.error({ err, task_id }, "failed to create initial reply");
        updateStatus(task_id, "failed");
        return;
      }
      setReplyMessageId(task_id, reply_message_id);

      updateStatus(task_id, "running");
      logAudit({
        ts: Math.floor(Date.now() / 1000),
        direction: "rpc_out",
        task_id,
        chat_id: msg.chat_id,
        extra: { method: "sendChat" },
      });

      const onChunk = (accumulated: string): void => {
        reply.throttledUpdate(task_id, reply_message_id, accumulated);
      };

      try {
        const fullReply = await transport.sendChat(
          task_id,
          msg.raw_text,
          onChunk,
        );

        const resultObj = { status: "success", reply: fullReply };
        setResult(task_id, JSON.stringify(resultObj));
        updateStatus(task_id, "done");
        reply.throttledUpdate(task_id, reply_message_id, fullReply);
        await reply.forceFlush(task_id);
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
        const content = `❌ [task_${shortTaskId(task_id)}] failed\n  ${summary}`;
        reply.throttledUpdate(task_id, reply_message_id, content);
        await reply.forceFlush(task_id);
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
