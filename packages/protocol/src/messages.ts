import type { TaskId, Phase } from "./task.js";

// ─── JSON-RPC 2.0 envelopes ─────────────────────────────────────────

export interface JsonRpcRequest<M extends string, P> {
  jsonrpc: "2.0";
  id: string;
  method: M;
  params: P;
}

export interface JsonRpcNotification<M extends string, P> {
  jsonrpc: "2.0";
  method: M;
  params: P;
}

export interface JsonRpcSuccessResponse<R> {
  jsonrpc: "2.0";
  id: string;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R> =
  | JsonRpcSuccessResponse<R>
  | JsonRpcErrorResponse;

// ─── Business messages ──────────────────────────────────────────────

// Outbound from bot-host → agent-core

export interface ExecuteTaskParams {
  chat_id: string;
  user_id: string;
  user_name: string;
  text: string;
  message_id: string;
  ts: number;
}

export interface ExecuteTaskResult {
  status: "success" | "failure";
  summary: string;
  branch?: string;
  files_changed?: string[];
  duration_ms: number;
}

export type ExecuteTaskRequest = JsonRpcRequest<
  "execute_task",
  ExecuteTaskParams
>;
export type ExecuteTaskResponse = JsonRpcResponse<ExecuteTaskResult>;

export interface CancelTaskParams {
  task_id: TaskId;
  reason?: string;
}

export type CancelTaskRequest = JsonRpcRequest<"cancel_task", CancelTaskParams>;
export type CancelTaskResponse = JsonRpcResponse<{ cancelled: boolean }>;

// Inbound to bot-host from agent-core

export interface ReportProgressParams {
  task_id: TaskId;
  phase: Phase;
  chunk: string;
  is_final: boolean;
}

export type ReportProgressNotification = JsonRpcNotification<
  "report_progress",
  ReportProgressParams
>;

// Bidirectional

export type PingNotification = JsonRpcNotification<"ping", { ts: number }>;
export type PongNotification = JsonRpcNotification<"pong", { ts: number }>;

// ─── Union types ────────────────────────────────────────────────────

export type OutboundRequest = ExecuteTaskRequest | CancelTaskRequest;
export type InboundNotification =
  | ReportProgressNotification
  | PongNotification;
export type InboundMessage =
  | InboundNotification
  | ExecuteTaskResponse
  | CancelTaskResponse;
