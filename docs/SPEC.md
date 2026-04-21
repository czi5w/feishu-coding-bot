# Specification — Feishu Coding Bot

> Precise interface contracts. All types and schemas in this document are the source of truth.
> **If code disagrees with this document, the code is wrong.**
> Last updated: 2026-04-20

---

## 1. Versions & Toolchain

Pin these exactly. Do not upgrade without explicit instruction.

| Tool | Version | Purpose |
|---|---|---|
| Node.js | `>=20.11.0 <21` | Runtime (LTS) |
| pnpm | `>=9.0.0` | Package manager |
| TypeScript | `^5.4.0` | Compiler |
| tsx | `^4.7.0` | TS dev runner |
| Vitest | `^2.0.0` | Test framework |
| zod | `^3.23.0` | Runtime validation |
| ws | `^8.16.0` | WebSocket library |
| @larksuiteoapi/node-sdk | `^1.35.0` | Feishu SDK |
| better-sqlite3 | `^11.0.0` | SQLite (sync API) |
| execa | `^9.0.0` | Subprocess (Cursor CLI) |
| pino | `^9.0.0` | Structured logging |
| ulid | `^2.3.0` | Task ID generator |
| dotenv | `^16.4.0` | .env loading |

**Node version**: 20.x LTS only. `better-sqlite3` native bindings are version-sensitive.

---

## 2. Package Manifest

### Root `package.json`

```json
{
  "name": "feishu-coding-bot",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.11.0 <21", "pnpm": ">=9" },
  "scripts": {
    "dev": "bash scripts/dev-all.sh",
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit -p tsconfig.base.json",
    "smoke": "bash scripts/smoke.sh"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "tsx": "^4.7.0",
    "vitest": "^2.0.0"
  }
}
```

### `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
```

### `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

### Package-level `tsconfig.json` (example for `bot-host`)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "references": [{ "path": "../protocol" }]
}
```

---

## 3. Protocol Package — Type Definitions

All types live in `packages/protocol/src/`. Code below is the authoritative source; copy verbatim into the files.

### 3.1 `task.ts`

```typescript
export type TaskId = string; // ULID, 26 chars

export const TASK_PHASES = [
  "queued",
  "planning",
  "editing",
  "testing",
  "done",
  "failed",
] as const;
export type Phase = (typeof TASK_PHASES)[number];

export interface TaskContext {
  task_id: TaskId;
  chat_id: string;
  user_id: string;
  user_name: string;
  instruction: string;
  message_id: string;
  ts: number; // unix seconds
}
```

### 3.2 `messages.ts`

```typescript
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
```

### 3.3 `errors.ts`

```typescript
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
```

### 3.4 `schemas.ts` (zod runtime validation)

```typescript
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
```

### 3.5 `index.ts`

```typescript
export * from "./task.js";
export * from "./messages.js";
export * from "./errors.js";
export * from "./schemas.js";
```

---

## 4. CodeExecutor Interface

Lives in `packages/agent-core/src/executor/types.ts`.

```typescript
import type { TaskId, Phase } from "@feishu-bot/protocol";

export interface ExecutionContext {
  readonly task_id: TaskId;
  readonly instruction: string;
  readonly workspace: string; // absolute path
  readonly signal: AbortSignal;
}

export interface ProgressEvent {
  readonly phase: Phase;
  readonly chunk: string;
  readonly is_final: boolean;
}

export interface ExecutionResult {
  readonly status: "success" | "failure";
  readonly summary: string;
  readonly branch?: string;
  readonly files_changed?: string[];
}

export interface CodeExecutor {
  readonly name: string;

  /**
   * Execute a task, yielding progress events, culminating in a final result.
   * The last yielded event MUST have is_final=true.
   * Throws on unrecoverable failure (which will become a JSON-RPC error response).
   */
  execute(ctx: ExecutionContext): AsyncGenerator<ProgressEvent, ExecutionResult, void>;
}
```

### Implementations

- **MockExecutor**: deterministic timing for tests. See TASKS D2.
- **CursorExecutor**: spawns `cursor-agent`, parses streamed output. See TASKS F1.

### CursorExecutor Hard Constraints (write into code as comments + assertions)

1. Every run creates branch `ai/${task_id_last8}` from current HEAD. **Never** commits to `main`/`master`.
2. If working tree is dirty at start, abort with `WORKSPACE_INVALID` before invoking Cursor.
3. Timeout = 10 minutes, enforced by AbortController. On timeout yield `phase: "failed"` and throw.
4. `cursor-agent` stderr is captured and attached to failure results' `summary`.

---

## 5. SQLite Schema

File: `packages/bot-host/src/storage/db.ts` initializes schema on first run.

```sql
-- audit_log: every inbound/outbound event
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  direction  TEXT    NOT NULL CHECK(direction IN ('in','out','reject','rpc_out','rpc_in')),
  chat_id    TEXT,
  user_id    TEXT,
  task_id    TEXT,
  raw_text   TEXT,
  extra      TEXT -- JSON
);
CREATE INDEX IF NOT EXISTS idx_audit_ts      ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_task    ON audit_log(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_chat_ts ON audit_log(chat_id, ts);

-- task_state: business-level task lifecycle
CREATE TABLE IF NOT EXISTS task_state (
  task_id       TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  reply_message_id TEXT,          -- bot's reply message id (for edits)
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK(status IN
                    ('queued','running','done','failed','cancelled','orphaned')),
  request_json  TEXT NOT NULL,
  result_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status  ON task_state(status);
CREATE INDEX IF NOT EXISTS idx_task_updated ON task_state(updated_ts);

-- dedup_event: Feishu event_id LRU persisted for 1h
CREATE TABLE IF NOT EXISTS dedup_event (
  event_id  TEXT PRIMARY KEY,
  seen_ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_ts ON dedup_event(seen_ts);
```

### Storage API (stable surface)

```typescript
// packages/bot-host/src/storage/audit.ts
export interface AuditEntry {
  ts: number;
  direction: "in" | "out" | "reject" | "rpc_out" | "rpc_in";
  chat_id?: string;
  user_id?: string;
  task_id?: string;
  raw_text?: string;
  extra?: Record<string, unknown>;
}
export function logAudit(entry: AuditEntry): void;

// packages/bot-host/src/storage/task-store.ts
export interface TaskRecord {
  task_id: string;
  chat_id: string;
  user_id: string;
  message_id: string;
  reply_message_id?: string;
  created_ts: number;
  updated_ts: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "orphaned";
  request_json: string;
  result_json?: string;
}
export function createTask(rec: Omit<TaskRecord, "updated_ts">): void;
export function updateStatus(task_id: string, status: TaskRecord["status"]): void;
export function setReplyMessageId(task_id: string, msg_id: string): void;
export function setResult(task_id: string, result_json: string): void;
export function markOrphansOnBoot(): string[]; // returns orphaned task_ids
export function getTask(task_id: string): TaskRecord | undefined;
```

---

## 6. Configuration (Environment Variables)

Complete `.env.example`:

```bash
# ── Feishu (bot-host only) ──────────────────────────────────────
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_BOT_OPEN_ID=ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ── Whitelist (bot-host only) — comma-separated ─────────────────
ALLOWED_CHAT_IDS=oc_test_chat_id
ALLOWED_USER_IDS=ou_ziqiang_open_id

# ── Transport ───────────────────────────────────────────────────
# bot-host: where agent-core listens
INNER_WS_URL=ws://192.168.100.2:8765
WS_RECONNECT_MIN_MS=1000
WS_RECONNECT_MAX_MS=60000
WS_HEARTBEAT_MS=15000

# agent-core: listen config
AGENT_WS_HOST=0.0.0.0
AGENT_WS_PORT=8765

# ── Storage (bot-host only) ─────────────────────────────────────
AUDIT_DB_PATH=./data/audit.db

# ── Executor (agent-core only) ──────────────────────────────────
EXECUTOR_KIND=mock               # mock | cursor
EXECUTOR_WORKSPACE=/absolute/path/to/target/repo
EXECUTOR_TIMEOUT_MS=600000        # 10 min
CURSOR_CLI_BINARY=cursor-agent    # or absolute path

# ── Runtime ─────────────────────────────────────────────────────
LOG_LEVEL=info                    # trace|debug|info|warn|error
REPLY_THROTTLE_MS=2000
MAX_CONCURRENT_TASKS=1
```

Each package has a `config.ts` that loads via `dotenv`, validates with zod, exports a frozen object. **Missing required vars = exit 1 at startup**, never fail silently.

---

## 7. Feishu Integration Details

### 7.1 Required Application Permissions

Apply on Feishu Open Platform:

- `im:message` — read/write messages
- `im:message.group_at_msg:readonly` — receive @ events in groups
- `im:message:send_as_bot` — send messages as bot

### 7.2 Event Subscription

Use `lark-oapi` long-connection (WebSocket) mode. Do **not** configure an HTTP webhook.

```typescript
import * as lark from "@larksuiteoapi/node-sdk";

const eventDispatcher = new lark.EventDispatcher({
  encryptKey: "", // not used in WS mode
  verificationToken: "",
}).register({
  "im.message.receive_v1": onMessageReceive,
});

const wsClient = new lark.WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});

wsClient.start({ eventDispatcher });
```

### 7.3 @Mention Parsing

Incoming message content is LarkMd format. `@bot` appears as:

```
<at user_id="ou_bot_open_id" user_name="编程机器人"></at> 实际指令文本
```

Parser MUST:
1. Verify the at-block's `user_id` matches `FEISHU_BOT_OPEN_ID` (otherwise ignore)
2. Strip ALL `<at ...></at>` blocks
3. Trim whitespace
4. If residual text length < 2 chars, ignore (just a ping, no instruction)

### 7.4 Reply Strategy

- First reply for a task: `im.v1.message.create` with `reply_in_thread` = true
- Subsequent progress updates: `im.v1.message.patch` on the same message_id (coalesced by throttle)
- Final result: another patch, appending status line and branch link

Format for in-progress messages:

```
🟡 [task_abc12345] planning
  → 正在分析 handleLogin 函数
```

Format for final message:

```
✅ [task_abc12345] done (48s)
  已在第 42 行加入 null check
  分支: ai/abc12345
  变更: src/login.ts
```

---

## 8. WebSocket Server Behavior (agent-core)

### 8.1 Startup

- Listen on `AGENT_WS_HOST:AGENT_WS_PORT`
- Accept exactly **one** active client connection at a time
- If a new connection arrives while one is active: close the new one with code 1013 (try again later)

### 8.2 Message Routing

Every received frame:

1. Parse JSON (parse error → send `{ error: { code: -32700, message: "Parse error" } }` with `id: null`)
2. Validate via `inboundToAgentSchema` (invalid → `-32600` invalid request)
3. Route by method:
   - `execute_task` → `TaskManager.enqueue`
   - `cancel_task` → `TaskManager.cancel`
   - `ping` → send `pong` notification
4. Unknown method → `-32601` method not found

### 8.3 TaskManager

- Maintains a `Map<TaskId, AbortController>` of active tasks
- `enqueue` respects `MAX_CONCURRENT_TASKS` (default 1)
- If at limit: immediately respond with error `-32007` CONCURRENCY_LIMIT
- For each active task: iterates executor's AsyncGenerator, sends `report_progress` notification per event, final event → sends response
- On `cancel_task`: calls `AbortController.abort()`, responds `{ cancelled: true }`
- On executor throw: sends error response with mapped code

### 8.4 Heartbeat

- Track `last_client_ts` updated on every incoming message
- If > 45s elapsed (3× heartbeat interval): close connection with code 1011

---

## 9. WebSocket Client Behavior (bot-host)

### 9.1 Connection State Machine

```
IDLE ──connect()──▶ CONNECTING ──open──▶ OPEN
                         │                 │
                         │ error           │ close/error
                         ▼                 ▼
                     BACKOFF ◀───── (with retry)
```

- Exponential backoff: `min(WS_RECONNECT_MIN_MS * 2^attempt, WS_RECONNECT_MAX_MS)`
- Reset attempt counter on successful OPEN
- While not OPEN: outbound messages go into an **in-memory queue** (capped at 100). On OPEN: flush.

### 9.2 Request/Response Matching

- Maintain `pending: Map<string, { resolve, reject, onProgress }>`
- `sendRequest(req, onProgress)`: register in `pending`, write frame, return Promise
- On response: lookup by `id`, remove, resolve/reject
- On `report_progress` notification: lookup by `params.task_id`, call `onProgress`
- Orphan cleanup: any `pending` entry older than 15 min → reject with timeout error

### 9.3 Heartbeat

- Send `ping` every `WS_HEARTBEAT_MS`
- If no `pong` for > 45s: close and trigger reconnect

---

## 10. Logging Standards

Use `pino`. One logger instance per package, created in `main.ts`, imported via module local re-export.

**Required fields on every log line** (automatic via pino bindings):
- `service`: `"bot-host"` or `"agent-core"`
- `pid`: process id

**Contextual fields** (per call):
- `task_id`: when within a task context
- `chat_id`, `user_id`: when handling Feishu event
- `rpc_id`: when handling WS request/response
- `err`: for errors (use `logger.error({ err }, "msg")` not `err.toString()`)

**Levels**:
- `trace`: per-frame WS content (disabled in prod)
- `debug`: state transitions, per-message decisions
- `info`: task lifecycle milestones, connection events
- `warn`: recoverable failures, retries, invalid input from Feishu
- `error`: unrecoverable failures, uncaught exceptions

---

## 11. Error Mapping Table

How executor failures become JSON-RPC errors:

| Cause | Code | Message |
|---|---|---|
| Executor throws `AbortError` | `-32003` EXECUTOR_CANCELLED | `"cancelled by user"` |
| Executor timeout (AbortController) | `-32002` EXECUTOR_TIMEOUT | `"exceeded {n}ms"` |
| Cursor CLI exit code != 0 | `-32004` EXECUTOR_FAILED | `"cursor-agent exit {code}"` (stderr tail in data) |
| Working tree dirty at start | `-32006` WORKSPACE_INVALID | `"workspace has uncommitted changes"` |
| `cursor-agent` not found | `-32001` EXECUTOR_UNAVAILABLE | `"cursor-agent not on PATH"` |
| MAX_CONCURRENT_TASKS exceeded | `-32007` CONCURRENCY_LIMIT | `"another task is running"` |

All others → `-32603` INTERNAL_ERROR with anonymized message; full stack to logs only.

---

## 12. Testing Conventions

### Test file layout

- Unit tests: co-located, `foo.ts` → `foo.test.ts`
- Integration tests: `packages/*/tests/integration/*.test.ts`
- E2E smoke: `scripts/smoke.sh`

### Vitest config (root `vitest.workspace.ts`)

```typescript
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/protocol",
  "packages/bot-host",
  "packages/agent-core",
]);
```

### Coverage floor

No hard thresholds, but each package's core module (parser, router, task-manager, ws-client) must have **at least one test per exported function**.

### Mocking rules

- Use `vi.mock` only for external boundaries (lark SDK, ws, execa, better-sqlite3)
- Never mock internal modules of the same package — refactor to make them testable instead
- Use `MockExecutor` for integration tests, not mocks of CursorExecutor
