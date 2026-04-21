/** JSON-RPC 2.0 standard codes */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Business codes (−32001 … −32099 reserved for server-defined) */
export const BUSINESS_ERRORS = {
  EXECUTOR_UNAVAILABLE: -32001,
  EXECUTOR_TIMEOUT: -32002,
  EXECUTOR_CANCELLED: -32003,
  EXECUTOR_FAILED: -32004,
  TASK_NOT_FOUND: -32005,
  WORKSPACE_INVALID: -32006,
  CONCURRENCY_LIMIT: -32007,
} as const;

export type ErrorCode =
  | (typeof JSON_RPC_ERRORS)[keyof typeof JSON_RPC_ERRORS]
  | (typeof BUSINESS_ERRORS)[keyof typeof BUSINESS_ERRORS];

export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

export function makeError(
  code: ErrorCode,
  message: string,
  data?: unknown
): RpcError {
  return data === undefined ? { code, message } : { code, message, data };
}
