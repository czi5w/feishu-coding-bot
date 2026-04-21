import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTest, _setDbForTest, openDatabase, type Db } from "./db.js";
import {
  _countDedupRows,
  markEventSeen,
  pruneOldEvents,
} from "./dedup.js";

describe("dedup", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    _setDbForTest(db);
  });
  afterEach(() => {
    db.close();
    _resetDbForTest();
  });

  it("markEventSeen returns true on first insert", () => {
    expect(markEventSeen("evt_1", 100)).toBe(true);
  });

  it("markEventSeen returns false for duplicate event_id", () => {
    expect(markEventSeen("evt_1", 100)).toBe(true);
    expect(markEventSeen("evt_1", 200)).toBe(false);
  });

  it("preserves the original seen_ts on duplicate", () => {
    markEventSeen("evt_1", 100);
    markEventSeen("evt_1", 999);
    const row = db
      .prepare(`SELECT seen_ts FROM dedup_event WHERE event_id = ?`)
      .get("evt_1") as { seen_ts: number };
    expect(row.seen_ts).toBe(100);
  });

  it("pruneOldEvents removes entries older than ttl", () => {
    markEventSeen("old_1", 100);
    markEventSeen("old_2", 200);
    markEventSeen("new_1", 9_000);

    // now=10000, ttl=3600 → cutoff=6400. Both old_* are before cutoff; new_1 stays.
    const removed = pruneOldEvents(10_000, 3_600);
    expect(removed).toBe(2);
    expect(_countDedupRows()).toBe(1);
  });

  it("pruneOldEvents returns 0 when nothing is stale", () => {
    markEventSeen("recent", 9_999);
    expect(pruneOldEvents(10_000, 3_600)).toBe(0);
  });
});
