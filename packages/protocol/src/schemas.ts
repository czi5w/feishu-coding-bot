import { z } from "zod";
import { TASK_PHASES } from "./task.js";

// Envelopes
const jsonRpcBase = z.object({ jsonrpc: z.literal("2.0") });

export const executeTaskParamsSchema = z.object({
  chat_id: z.string().min(1),
  user_id: z.string().min(1),
  user_name: z.string(),
  text: z.string().min(1).max(8192),
  message_id: z.string().min(1),
  ts: z.number().int().positive(),
});

export const executeTaskRequestSchema = jsonRpcBase.extend({
  id: z.string().min(1),
  method: z.literal("execute_task"),
  params: executeTaskParamsSchema,
});

export const executeTaskResultSchema = z.object({
  status: z.enum(["success", "failure"]),
  summary: z.string(),
  branch: z.string().optional(),
  files_changed: z.array(z.string()).optional(),
  duration_ms: z.number().int().nonnegative(),
});

export const reportProgressParamsSchema = z.object({
  task_id: z.string().length(26),
  phase: z.enum(TASK_PHASES),
  chunk: z.string().max(4096),
  is_final: z.boolean(),
});

export const reportProgressNotificationSchema = jsonRpcBase.extend({
  method: z.literal("report_progress"),
  params: reportProgressParamsSchema,
});

export const cancelTaskRequestSchema = jsonRpcBase.extend({
  id: z.string().min(1),
  method: z.literal("cancel_task"),
  params: z.object({
    task_id: z.string().length(26),
    reason: z.string().optional(),
  }),
});

export const pingNotificationSchema = jsonRpcBase.extend({
  method: z.literal("ping"),
  params: z.object({ ts: z.number().int().positive() }),
});

export const pongNotificationSchema = jsonRpcBase.extend({
  method: z.literal("pong"),
  params: z.object({ ts: z.number().int().positive() }),
});

// Response envelope (generic)
export const jsonRpcErrorResponseSchema = jsonRpcBase.extend({
  id: z.string().nullable(),
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});

// Discriminated unions for inbound routing
export const inboundToBotSchema = z.union([
  reportProgressNotificationSchema,
  pongNotificationSchema,
  // responses don't carry a method, match by id presence:
  z.object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: executeTaskResultSchema,
  }),
  jsonRpcErrorResponseSchema,
]);

export const inboundToAgentSchema = z.union([
  executeTaskRequestSchema,
  cancelTaskRequestSchema,
  pingNotificationSchema,
]);
