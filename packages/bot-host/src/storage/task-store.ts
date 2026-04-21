import { getDb } from "./db.js";

export type TaskStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "orphaned";

export interface TaskRecord {
  task_id: string;
  chat_id: string;
  user_id: string;
  message_id: string;
  reply_message_id?: string;
  created_ts: number;
  updated_ts: number;
  status: TaskStatus;
  request_json: string;
  result_json?: string;
}

interface TaskRow {
  task_id: string;
  chat_id: string;
  user_id: string;
  message_id: string;
  reply_message_id: string | null;
  created_ts: number;
  updated_ts: number;
  status: TaskStatus;
  request_json: string;
  result_json: string | null;
}

function rowToRecord(row: TaskRow): TaskRecord {
  const out: TaskRecord = {
    task_id: row.task_id,
    chat_id: row.chat_id,
    user_id: row.user_id,
    message_id: row.message_id,
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
    status: row.status,
    request_json: row.request_json,
  };
  if (row.reply_message_id !== null) out.reply_message_id = row.reply_message_id;
  if (row.result_json !== null) out.result_json = row.result_json;
  return out;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function createTask(rec: Omit<TaskRecord, "updated_ts">): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO task_state
       (task_id, chat_id, user_id, message_id, reply_message_id,
        created_ts, updated_ts, status, request_json, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rec.task_id,
    rec.chat_id,
    rec.user_id,
    rec.message_id,
    rec.reply_message_id ?? null,
    rec.created_ts,
    rec.created_ts,
    rec.status,
    rec.request_json,
    rec.result_json ?? null,
  );
}

export function updateStatus(task_id: string, status: TaskStatus): void {
  const db = getDb();
  db.prepare(
    `UPDATE task_state SET status = ?, updated_ts = ? WHERE task_id = ?`,
  ).run(status, now(), task_id);
}

export function setReplyMessageId(task_id: string, msg_id: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE task_state SET reply_message_id = ?, updated_ts = ? WHERE task_id = ?`,
  ).run(msg_id, now(), task_id);
}

export function setResult(task_id: string, result_json: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE task_state SET result_json = ?, updated_ts = ? WHERE task_id = ?`,
  ).run(result_json, now(), task_id);
}

export interface OrphanedTask {
  task_id: string;
  chat_id: string;
  reply_message_id?: string;
  created_ts: number;
}

/**
 * On boot: any task left in queued/running state has been orphaned by a crash.
 * Mark them as 'orphaned' and return enough metadata for the caller to notify
 * the originating chat.
 */
export function markOrphansOnBoot(): OrphanedTask[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT task_id, chat_id, reply_message_id, created_ts
         FROM task_state WHERE status IN ('queued', 'running')`,
    )
    .all() as {
    task_id: string;
    chat_id: string;
    reply_message_id: string | null;
    created_ts: number;
  }[];
  if (rows.length === 0) return [];

  const stmt = db.prepare(
    `UPDATE task_state SET status = 'orphaned', updated_ts = ? WHERE task_id = ?`,
  );
  const ts = now();
  const tx = db.transaction((list: { task_id: string }[]) => {
    for (const r of list) stmt.run(ts, r.task_id);
  });
  tx(rows);

  return rows.map((r) => {
    const o: OrphanedTask = {
      task_id: r.task_id,
      chat_id: r.chat_id,
      created_ts: r.created_ts,
    };
    if (r.reply_message_id !== null) o.reply_message_id = r.reply_message_id;
    return o;
  });
}

export function getTask(task_id: string): TaskRecord | undefined {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM task_state WHERE task_id = ?`)
    .get(task_id) as TaskRow | undefined;
  return row ? rowToRecord(row) : undefined;
}
