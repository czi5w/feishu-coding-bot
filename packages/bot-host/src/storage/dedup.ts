import { getDb } from "./db.js";

/**
 * Record that a Feishu event was seen. Returns true if this is the first time
 * (caller should process it), false if it was already in the table (duplicate).
 *
 * The write is atomic via SQLite's INSERT … ON CONFLICT: no race between the
 * INSERT and the subsequent SELECT.
 */
export function markEventSeen(event_id: string, ts: number): boolean {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO dedup_event (event_id, seen_ts) VALUES (?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .run(event_id, ts);
  return info.changes === 1;
}

/** TTL cleanup — delete entries older than (now_ts - ttl_seconds). */
export function pruneOldEvents(now_ts: number, ttl_seconds = 3600): number {
  const db = getDb();
  const info = db
    .prepare(`DELETE FROM dedup_event WHERE seen_ts < ?`)
    .run(now_ts - ttl_seconds);
  return info.changes;
}

/** Test helper — query the count. */
export function _countDedupRows(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM dedup_event`)
    .get() as { n: number };
  return row.n;
}
