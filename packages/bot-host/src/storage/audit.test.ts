import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTest, _setDbForTest, openDatabase, type Db } from "./db.js";
import { logAudit } from "./audit.js";

describe("logAudit", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    _setDbForTest(db);
  });
  afterEach(() => {
    db.close();
    _resetDbForTest();
  });

  it("persists a minimal inbound entry", () => {
    logAudit({ ts: 1, direction: "in", raw_text: "hello" });
    const rows = db.prepare(`SELECT * FROM audit_log`).all() as {
      direction: string;
      raw_text: string | null;
      chat_id: string | null;
      extra: string | null;
    }[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.direction).toBe("in");
    expect(row.raw_text).toBe("hello");
    expect(row.chat_id).toBeNull();
    expect(row.extra).toBeNull();
  });

  it("serializes extra as JSON", () => {
    logAudit({
      ts: 2,
      direction: "rpc_out",
      task_id: "01HN4XY0000000000000000000",
      extra: { retries: 3 },
    });
    const row = db
      .prepare(`SELECT extra FROM audit_log WHERE task_id = ?`)
      .get("01HN4XY0000000000000000000") as { extra: string };
    expect(JSON.parse(row.extra)).toEqual({ retries: 3 });
  });

  it("preserves insertion order via auto-increment id", () => {
    logAudit({ ts: 1, direction: "in", raw_text: "a" });
    logAudit({ ts: 2, direction: "rpc_out", raw_text: "b" });
    logAudit({ ts: 3, direction: "rpc_in", raw_text: "c" });
    const rows = db
      .prepare(`SELECT raw_text FROM audit_log ORDER BY id`)
      .all() as { raw_text: string }[];
    expect(rows.map((r) => r.raw_text)).toEqual(["a", "b", "c"]);
  });
});
