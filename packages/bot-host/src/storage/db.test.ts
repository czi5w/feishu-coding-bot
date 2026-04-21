import { afterEach, describe, expect, it } from "vitest";
import { _resetDbForTest, _setDbForTest, openDatabase } from "./db.js";

describe("openDatabase", () => {
  afterEach(() => _resetDbForTest());

  it("creates schema and indexes idempotently", () => {
    const db = openDatabase(":memory:");
    _setDbForTest(db);

    // Second call on the same handle should not throw.
    db.exec(
      `CREATE TABLE IF NOT EXISTS audit_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL,
         direction TEXT NOT NULL CHECK(direction IN ('in','out','reject','rpc_out','rpc_in')),
         chat_id TEXT, user_id TEXT, task_id TEXT, raw_text TEXT, extra TEXT
       );`,
    );

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("audit_log");
    expect(names).toContain("task_state");
    expect(names).toContain("dedup_event");
  });

  it("enforces the direction CHECK constraint", () => {
    const db = openDatabase(":memory:");
    _setDbForTest(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO audit_log (ts, direction) VALUES (?, ?)`,
        )
        .run(1, "garbage"),
    ).toThrow();
  });

  it("enforces the task status CHECK constraint", () => {
    const db = openDatabase(":memory:");
    _setDbForTest(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_state
             (task_id, chat_id, user_id, message_id, created_ts, updated_ts, status, request_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("t1", "c", "u", "m", 1, 1, "nonsense", "{}"),
    ).toThrow();
  });
});
