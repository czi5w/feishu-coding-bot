import type { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import type { Logger } from "pino";
import { shortTaskId } from "../feishu/reply.js";
import { logAudit } from "../storage/audit.js";
import {
  markOrphansOnBoot,
  type OrphanedTask,
} from "../storage/task-store.js";

/** Tasks older than this are considered stale and only marked — no chat notice. */
export const ORPHAN_STALE_SECONDS = 24 * 60 * 60;

export interface RecoverOrphansDeps {
  /** Feishu HTTP client; only `im.message.create` is used. */
  api: Pick<LarkClient, "im">;
  /** Injected for tests; production passes `Date.now`. */
  now?: () => number;
  logger?: Logger;
}

export interface OrphanRecoveryReport {
  orphaned: OrphanedTask[];
  notified: string[];
  skippedStale: string[];
}

/**
 * Mark orphans on boot and notify each originating chat so users know to
 * resend the instruction. Stale tasks (> 24h old) are marked but not
 * notified — the user has likely moved on.
 *
 * Notification failures are logged but don't fail the boot.
 */
export async function recoverOrphans(
  deps: RecoverOrphansDeps,
): Promise<OrphanRecoveryReport> {
  const now = deps.now ?? Date.now;
  const nowSec = Math.floor(now() / 1000);
  const orphans = markOrphansOnBoot();
  const notified: string[] = [];
  const skippedStale: string[] = [];

  for (const t of orphans) {
    const ageSec = nowSec - t.created_ts;
    if (ageSec > ORPHAN_STALE_SECONDS) {
      skippedStale.push(t.task_id);
      deps.logger?.info(
        { task_id: t.task_id, age_sec: ageSec },
        "orphan too old, skipping notify",
      );
      continue;
    }
    const text = `⚠️ [task_${shortTaskId(t.task_id)}] 上次该任务中断,请重新发送指令`;
    try {
      await deps.api.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: t.chat_id,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      });
      notified.push(t.task_id);
      logAudit({
        ts: nowSec,
        direction: "out",
        task_id: t.task_id,
        chat_id: t.chat_id,
        raw_text: text,
        extra: { reason: "orphan_recovery" },
      });
    } catch (err: unknown) {
      deps.logger?.warn(
        { err, task_id: t.task_id, chat_id: t.chat_id },
        "failed to notify orphan recovery",
      );
    }
  }

  if (orphans.length > 0) {
    deps.logger?.info(
      {
        orphaned: orphans.length,
        notified: notified.length,
        skipped_stale: skippedStale.length,
      },
      "orphan recovery complete",
    );
  }

  return { orphaned: orphans, notified, skippedStale };
}
