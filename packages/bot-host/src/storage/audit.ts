import { getDb } from "./db.js";

export type AuditDirection = "in" | "out" | "reject" | "rpc_out" | "rpc_in";

export interface AuditEntry {
  ts: number;
  direction: AuditDirection;
  chat_id?: string;
  user_id?: string;
  task_id?: string;
  raw_text?: string;
  extra?: Record<string, unknown>;
}

export function logAudit(entry: AuditEntry): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_log (ts, direction, chat_id, user_id, task_id, raw_text, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.ts,
    entry.direction,
    entry.chat_id ?? null,
    entry.user_id ?? null,
    entry.task_id ?? null,
    entry.raw_text ?? null,
    entry.extra === undefined ? null : JSON.stringify(entry.extra),
  );
}
