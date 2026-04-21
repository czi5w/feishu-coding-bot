import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";

const SCHEMA_SQL = `
-- audit_log: every inbound/outbound event
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  direction  TEXT    NOT NULL CHECK(direction IN ('in','out','reject','rpc_out','rpc_in')),
  chat_id    TEXT,
  user_id    TEXT,
  task_id    TEXT,
  raw_text   TEXT,
  extra      TEXT -- JSON
);
CREATE INDEX IF NOT EXISTS idx_audit_ts      ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_task    ON audit_log(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_chat_ts ON audit_log(chat_id, ts);

-- task_state: business-level task lifecycle
CREATE TABLE IF NOT EXISTS task_state (
  task_id       TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  reply_message_id TEXT,
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK(status IN
                    ('queued','running','done','failed','cancelled','orphaned')),
  request_json  TEXT NOT NULL,
  result_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status  ON task_state(status);
CREATE INDEX IF NOT EXISTS idx_task_updated ON task_state(updated_ts);

-- dedup_event: Feishu event_id LRU persisted for 1h
CREATE TABLE IF NOT EXISTS dedup_event (
  event_id  TEXT PRIMARY KEY,
  seen_ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_ts ON dedup_event(seen_ts);
`;

export type Db = DatabaseType;

/**
 * Open a SQLite database at the given path and run schema migrations idempotently.
 * Pass `:memory:` for an ephemeral in-test database.
 */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    // Ensure parent directory exists; safe on repeat calls.
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

// ─── Module-level singleton for production callers ────────────────────
// Tests import openDatabase directly and pass their own handle around.

let _singleton: Db | undefined;

export function initDefaultDatabase(path: string): Db {
  if (_singleton) return _singleton;
  _singleton = openDatabase(path);
  return _singleton;
}

export function getDb(): Db {
  if (!_singleton) {
    throw new Error(
      "database not initialized; call initDefaultDatabase(path) first",
    );
  }
  return _singleton;
}

/** Test helper — replaces the singleton. */
export function _setDbForTest(db: Db): void {
  _singleton = db;
}

/** Test helper — clears the singleton. */
export function _resetDbForTest(): void {
  _singleton = undefined;
}
