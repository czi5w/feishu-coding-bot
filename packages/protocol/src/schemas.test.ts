import { describe, expect, it } from "vitest";
import {
  cancelTaskRequestSchema,
  executeTaskRequestSchema,
  inboundToAgentSchema,
  reportProgressNotificationSchema,
} from "./schemas.js";
import { TASK_PHASES } from "./task.js";

const validExecuteTask = {
  jsonrpc: "2.0" as const,
  id: "01HN4XY0000000000000000000",
  method: "execute_task" as const,
  params: {
    chat_id: "oc_test",
    user_id: "ou_test",
    user_name: "Alice",
    text: "fix the login bug",
    message_id: "om_test",
    ts: 1_700_000_000,
  },
};

const sampleTaskId = "01HN4XY0000000000000000000"; // 26 chars (ULID-shaped)

describe("executeTaskRequestSchema", () => {
  it("parses a valid request and round-trips through JSON", () => {
    const parsed = executeTaskRequestSchema.parse(validExecuteTask);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(executeTaskRequestSchema.parse(serialized)).toEqual(parsed);
  });

  it("rejects when a required param is missing", () => {
    const { user_id: _omit, ...partial } = validExecuteTask.params;
    const bad = { ...validExecuteTask, params: partial };
    expect(() => executeTaskRequestSchema.parse(bad)).toThrow();
  });

  it("rejects when ts has the wrong type", () => {
    const bad = {
      ...validExecuteTask,
      params: { ...validExecuteTask.params, ts: "not-a-number" },
    };
    expect(() => executeTaskRequestSchema.parse(bad)).toThrow();
  });

  it("rejects empty text", () => {
    const bad = {
      ...validExecuteTask,
      params: { ...validExecuteTask.params, text: "" },
    };
    expect(() => executeTaskRequestSchema.parse(bad)).toThrow();
  });

  it("accepts text at the 8192 max length", () => {
    const maxText = "a".repeat(8192);
    const ok = {
      ...validExecuteTask,
      params: { ...validExecuteTask.params, text: maxText },
    };
    expect(() => executeTaskRequestSchema.parse(ok)).not.toThrow();
  });

  it("rejects text at 8193 chars", () => {
    const tooLong = "a".repeat(8193);
    const bad = {
      ...validExecuteTask,
      params: { ...validExecuteTask.params, text: tooLong },
    };
    expect(() => executeTaskRequestSchema.parse(bad)).toThrow();
  });
});

describe("reportProgressNotificationSchema", () => {
  for (const phase of TASK_PHASES) {
    it(`accepts phase='${phase}'`, () => {
      const frame = {
        jsonrpc: "2.0" as const,
        method: "report_progress" as const,
        params: {
          task_id: sampleTaskId,
          phase,
          chunk: `in ${phase}`,
          is_final: phase === "done" || phase === "failed",
        },
      };
      expect(() =>
        reportProgressNotificationSchema.parse(frame),
      ).not.toThrow();
    });
  }

  it("rejects a task_id that is not 26 chars", () => {
    const frame = {
      jsonrpc: "2.0" as const,
      method: "report_progress" as const,
      params: {
        task_id: "too-short",
        phase: "editing" as const,
        chunk: "...",
        is_final: false,
      },
    };
    expect(() => reportProgressNotificationSchema.parse(frame)).toThrow();
  });

  it("rejects an unknown phase", () => {
    const frame = {
      jsonrpc: "2.0",
      method: "report_progress",
      params: {
        task_id: sampleTaskId,
        phase: "refactoring",
        chunk: "...",
        is_final: false,
      },
    };
    expect(() => reportProgressNotificationSchema.parse(frame)).toThrow();
  });
});

describe("cancelTaskRequestSchema", () => {
  it("accepts without reason", () => {
    const frame = {
      jsonrpc: "2.0" as const,
      id: "req-1",
      method: "cancel_task" as const,
      params: { task_id: sampleTaskId },
    };
    expect(() => cancelTaskRequestSchema.parse(frame)).not.toThrow();
  });

  it("accepts with reason", () => {
    const frame = {
      jsonrpc: "2.0" as const,
      id: "req-1",
      method: "cancel_task" as const,
      params: { task_id: sampleTaskId, reason: "user cancelled" },
    };
    expect(() => cancelTaskRequestSchema.parse(frame)).not.toThrow();
  });
});

describe("inboundToAgentSchema", () => {
  it("rejects an unknown method", () => {
    const frame = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "not_a_real_method",
      params: {},
    };
    expect(() => inboundToAgentSchema.parse(frame)).toThrow();
  });

  it("accepts a valid ping notification", () => {
    const frame = {
      jsonrpc: "2.0",
      method: "ping",
      params: { ts: 1_700_000_000 },
    };
    expect(() => inboundToAgentSchema.parse(frame)).not.toThrow();
  });

  it("accepts a valid execute_task request", () => {
    expect(() => inboundToAgentSchema.parse(validExecuteTask)).not.toThrow();
  });
});
