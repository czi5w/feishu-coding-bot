import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTest, _setDbForTest, openDatabase, type Db } from "./db.js";
import {
  createTask,
  getTask,
  markOrphansOnBoot,
  setReplyMessageId,
  setResult,
  updateStatus,
} from "./task-store.js";

function sampleTask(id: string, status: "queued" | "done" = "queued") {
  return {
    task_id: id,
    chat_id: "oc_test",
    user_id: "ou_test",
    message_id: `om_${id}`,
    created_ts: 1_700_000_000,
    status,
    request_json: `{"task_id":"${id}"}`,
  };
}

describe("task-store", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:");
    _setDbForTest(db);
  });
  afterEach(() => {
    db.close();
    _resetDbForTest();
  });

  it("createTask then getTask round-trips", () => {
    createTask(sampleTask("01HN4XY0000000000000000001"));
    const rec = getTask("01HN4XY0000000000000000001");
    expect(rec).toBeDefined();
    expect(rec?.status).toBe("queued");
    expect(rec?.chat_id).toBe("oc_test");
    expect(rec?.updated_ts).toBe(rec?.created_ts);
    expect(rec?.reply_message_id).toBeUndefined();
    expect(rec?.result_json).toBeUndefined();
  });

  it("getTask returns undefined for unknown id", () => {
    expect(getTask("01HN4XY9999999999999999999")).toBeUndefined();
  });

  it("updateStatus bumps status and updated_ts", async () => {
    createTask(sampleTask("01HN4XY0000000000000000002"));
    const before = getTask("01HN4XY0000000000000000002")!;
    // Ensure monotonic clock advance.
    await new Promise((r) => setTimeout(r, 1010));
    updateStatus("01HN4XY0000000000000000002", "running");
    const after = getTask("01HN4XY0000000000000000002")!;
    expect(after.status).toBe("running");
    expect(after.updated_ts).toBeGreaterThanOrEqual(before.updated_ts);
  });

  it("setReplyMessageId persists reply id", () => {
    createTask(sampleTask("01HN4XY0000000000000000003"));
    setReplyMessageId("01HN4XY0000000000000000003", "om_reply_1");
    expect(getTask("01HN4XY0000000000000000003")?.reply_message_id).toBe(
      "om_reply_1",
    );
  });

  it("setResult persists result_json", () => {
    createTask(sampleTask("01HN4XY0000000000000000004"));
    setResult("01HN4XY0000000000000000004", '{"status":"success"}');
    expect(getTask("01HN4XY0000000000000000004")?.result_json).toBe(
      '{"status":"success"}',
    );
  });

  it("markOrphansOnBoot converts queued/running to orphaned", () => {
    createTask(sampleTask("01HN4XY0000000000000000011", "queued"));
    createTask(sampleTask("01HN4XY0000000000000000012", "queued"));
    createTask(sampleTask("01HN4XY0000000000000000013", "done"));
    // Manually bump one to running.
    updateStatus("01HN4XY0000000000000000012", "running");

    const orphaned = markOrphansOnBoot();
    expect(orphaned.map((o) => o.task_id).sort()).toEqual([
      "01HN4XY0000000000000000011",
      "01HN4XY0000000000000000012",
    ]);
    for (const o of orphaned) {
      expect(o.chat_id).toBe("oc_test");
      expect(o.created_ts).toBe(1_700_000_000);
    }

    expect(getTask("01HN4XY0000000000000000011")?.status).toBe("orphaned");
    expect(getTask("01HN4XY0000000000000000012")?.status).toBe("orphaned");
    // 'done' must be untouched.
    expect(getTask("01HN4XY0000000000000000013")?.status).toBe("done");
  });

  it("markOrphansOnBoot returns empty list when nothing is pending", () => {
    createTask(sampleTask("01HN4XY0000000000000000021", "done"));
    expect(markOrphansOnBoot()).toEqual([]);
  });
});
