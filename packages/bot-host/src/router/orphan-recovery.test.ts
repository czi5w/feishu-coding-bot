import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetDbForTest,
  _setDbForTest,
  openDatabase,
  type Db,
} from "../storage/db.js";
import { createTask, getTask } from "../storage/task-store.js";
import {
  ORPHAN_STALE_SECONDS,
  recoverOrphans,
} from "./orphan-recovery.js";

function makeFakeApi() {
  const sent: Array<{ receive_id: string; text: string }> = [];
  const api = {
    im: {
      message: {
        create: vi.fn(
          async (args: {
            params: { receive_id_type: string };
            data: {
              receive_id: string;
              msg_type: string;
              content: string;
            };
          }) => {
            const text = JSON.parse(args.data.content).text as string;
            sent.push({ receive_id: args.data.receive_id, text });
            return { data: { message_id: `om_notify_${sent.length}` } };
          },
        ),
      },
    },
  };
  return { api, sent };
}

const NOW_SEC = 1_700_000_000;

function seedTask(
  id: string,
  opts: { status: "queued" | "running" | "done"; ageSec: number; chat?: string },
): void {
  createTask({
    task_id: id,
    chat_id: opts.chat ?? "oc_test",
    user_id: "ou_test",
    message_id: `om_${id}`,
    created_ts: NOW_SEC - opts.ageSec,
    status: opts.status,
    request_json: `{"task_id":"${id}"}`,
  });
}

describe("recoverOrphans", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
    _setDbForTest(db);
  });
  afterEach(() => {
    db.close();
    _resetDbForTest();
  });

  it("marks queued/running tasks orphaned and notifies fresh ones", async () => {
    const { api, sent } = makeFakeApi();
    seedTask("01HN4XY0000000000000000001", {
      status: "queued",
      ageSec: 60,
      chat: "oc_A",
    });
    seedTask("01HN4XY0000000000000000002", {
      status: "running",
      ageSec: 300,
      chat: "oc_B",
    });
    seedTask("01HN4XY0000000000000000003", {
      status: "done",
      ageSec: 10,
    });

    const report = await recoverOrphans({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      now: () => NOW_SEC * 1000,
    });

    expect(report.orphaned.map((o) => o.task_id).sort()).toEqual([
      "01HN4XY0000000000000000001",
      "01HN4XY0000000000000000002",
    ]);
    expect(report.notified.sort()).toEqual([
      "01HN4XY0000000000000000001",
      "01HN4XY0000000000000000002",
    ]);
    expect(report.skippedStale).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(sent.find((s) => s.receive_id === "oc_A")?.text).toContain("中断");
    expect(sent.find((s) => s.receive_id === "oc_A")?.text).toContain(
      "task_00000001",
    );
    // 'done' task must not be touched.
    expect(getTask("01HN4XY0000000000000000003")?.status).toBe("done");
    // orphaned ones should be flipped in the DB.
    expect(getTask("01HN4XY0000000000000000001")?.status).toBe("orphaned");
    expect(getTask("01HN4XY0000000000000000002")?.status).toBe("orphaned");
  });

  it("skips notifying tasks older than 24h but still marks them orphaned", async () => {
    const { api, sent } = makeFakeApi();
    seedTask("01HN4XY0000000000000000011", {
      status: "running",
      ageSec: ORPHAN_STALE_SECONDS + 60,
    });

    const report = await recoverOrphans({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      now: () => NOW_SEC * 1000,
    });

    expect(report.orphaned).toHaveLength(1);
    expect(report.notified).toEqual([]);
    expect(report.skippedStale).toEqual(["01HN4XY0000000000000000011"]);
    expect(sent).toHaveLength(0);
    expect(getTask("01HN4XY0000000000000000011")?.status).toBe("orphaned");
  });

  it("returns empty report when nothing is pending", async () => {
    const { api, sent } = makeFakeApi();
    seedTask("01HN4XY0000000000000000021", {
      status: "done",
      ageSec: 0,
    });

    const report = await recoverOrphans({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      now: () => NOW_SEC * 1000,
    });
    expect(report.orphaned).toEqual([]);
    expect(report.notified).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("records an audit 'out' entry for each notify", async () => {
    const { api } = makeFakeApi();
    seedTask("01HN4XY0000000000000000031", {
      status: "queued",
      ageSec: 5,
    });

    await recoverOrphans({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      now: () => NOW_SEC * 1000,
    });

    const rows = db
      .prepare(`SELECT direction, task_id, raw_text FROM audit_log`)
      .all() as { direction: string; task_id: string; raw_text: string }[];
    const out = rows.find((r) => r.direction === "out");
    expect(out).toBeDefined();
    expect(out!.task_id).toBe("01HN4XY0000000000000000031");
    expect(out!.raw_text).toContain("中断");
  });

  it("logs and swallows lark API errors without throwing", async () => {
    const { api } = makeFakeApi();
    api.im.message.create.mockRejectedValueOnce(new Error("lark down"));
    seedTask("01HN4XY0000000000000000041", {
      status: "queued",
      ageSec: 5,
    });
    seedTask("01HN4XY0000000000000000042", {
      status: "queued",
      ageSec: 5,
    });

    const report = await recoverOrphans({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      now: () => NOW_SEC * 1000,
    });
    // Both marked orphaned; only the second was notified.
    expect(report.orphaned).toHaveLength(2);
    expect(report.notified).toHaveLength(1);
  });
});
