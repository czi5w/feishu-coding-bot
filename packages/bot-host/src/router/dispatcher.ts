import { ulid } from "ulid";
import type { Logger } from "pino";
import type {
  ExecuteTaskParams,
  ExecuteTaskRequest,
  ExecuteTaskResult,
  Phase,
  ReportProgressParams,
} from "@feishu-bot/protocol";
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

/** Minimum interface dispatcher needs from the WS transport (implemented by E1). */
export interface Transport {
  sendExecuteTask(
    req: ExecuteTaskRequest,
    onProgress: (ev: ReportProgressParams) => void,
  ): Promise<ExecuteTaskResult>;
}

export interface DispatcherDeps {
  reply: ReplyClient;
  transport: Transport;
  logger?: Logger;
}

export interface Dispatcher {
  dispatch(msg: IncomingMessage): Promise<void>;
}

/** Format a mid-task progress update per SPEC §7.4. */
export function formatProgressMessage(
  task_id: string,
  phase: Phase,
  chunk: string,
): string {
  const head = `🟡 [task_${shortTaskId(task_id)}] ${phase}`;
  const body = chunk.trim();
  return body ? `${head}\n  → ${body}` : head;
}

/** Format the final ✅/❌ summary per SPEC §7.4. */
export function formatFinalMessage(
  task_id: string,
  result: ExecuteTaskResult,
): string {
  const icon = result.status === "success" ? "✅" : "❌";
  const durSec = Math.max(1, Math.round(result.duration_ms / 1000));
  const header = `${icon} [task_${shortTaskId(task_id)}] ${result.status} (${durSec}s)`;
  const lines = [header];
  if (result.summary) lines.push(`  ${result.summary}`);
  if (result.branch) lines.push(`  分支: ${result.branch}`);
  if (result.files_changed && result.files_changed.length > 0) {
    lines.push(`  变更: ${result.files_changed.join(", ")}`);
  }
  return lines.join("\n");
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { reply, transport } = deps;
  const log = deps.logger;

  return {
    async dispatch(msg: IncomingMessage): Promise<void> {
      const task_id = ulid();
      const params: ExecuteTaskParams = {
        chat_id: msg.chat_id,
        user_id: msg.user_id,
        user_name: msg.user_name,
        text: msg.raw_text, // caller must have already normalized
        message_id: msg.message_id,
        ts: msg.ts,
      };
      const req: ExecuteTaskRequest = {
        jsonrpc: "2.0",
        id: task_id,
        method: "execute_task",
        params,
      };
      const request_json = JSON.stringify(req);

      createTask({
        task_id,
        chat_id: msg.chat_id,
        user_id: msg.user_id,
        message_id: msg.message_id,
        created_ts: msg.ts,
        status: "queued",
        request_json,
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
        extra: { method: "execute_task" },
      });

      const onProgress = (ev: ReportProgressParams): void => {
        logAudit({
          ts: Math.floor(Date.now() / 1000),
          direction: "rpc_in",
          task_id,
          extra: { phase: ev.phase, is_final: ev.is_final },
        });
        const content = formatProgressMessage(task_id, ev.phase, ev.chunk);
        reply.throttledUpdate(task_id, reply_message_id, content);
      };

      try {
        const result = await transport.sendExecuteTask(req, onProgress);
        setResult(task_id, JSON.stringify(result));
        updateStatus(
          task_id,
          result.status === "success" ? "done" : "failed",
        );
        const finalText = formatFinalMessage(task_id, result);
        reply.throttledUpdate(task_id, reply_message_id, finalText);
        await reply.forceFlush(task_id);
        logAudit({
          ts: Math.floor(Date.now() / 1000),
          direction: "out",
          task_id,
          chat_id: msg.chat_id,
          raw_text: finalText,
        });
      } catch (err: unknown) {
        log?.error({ err, task_id }, "execute_task failed");
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
