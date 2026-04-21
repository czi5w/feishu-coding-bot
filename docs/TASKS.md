# Tasks — Feishu Coding Bot

> Atomic task breakdown for Claude Code. Execute in order within each phase.
> Each task lists: prerequisites, deliverables, and a verification command that must pass before declaring done.

---

## Task Dependency Graph

```
A1 ──▶ A2 ──▶ B1 ──▶ B2 ──┬──▶ C1 ──▶ C2 ──▶ C3 ──▶ C4 ──▶ C5
                          │
                          └──▶ D1 ──▶ D2 ──▶ D3 ──▶ D4
                                       │
                                       └──▶ E1 ──▶ E2 ──▶ E3
                                                     │
                                                     └──▶ F1 ──▶ F2
                                                                │
                                                                └──▶ G1 ──▶ G2
```

**Total tasks**: 22.  Phase C (bot-host) and Phase D (agent-core) can be executed in parallel after B2 completes.

---

## Phase A — Repository Bootstrap

### A1. Initialize monorepo skeleton

**Prereq**: none
**Deliverables**:
- `package.json` (root, from SPEC §2)
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `.gitignore` (node_modules, dist, *.db, .env)
- `.env.example` (full, from SPEC §6)
- Empty `packages/protocol/`, `packages/bot-host/`, `packages/agent-core/` directories
- `README.md` with quickstart

**Verify**:
```bash
pnpm install && pnpm -w exec tsc --version
# Expected: TypeScript version printed, no errors
```

### A2. Set up shared configs and scripts

**Prereq**: A1
**Deliverables**:
- `vitest.workspace.ts` (from SPEC §12)
- `scripts/dev-all.sh`: runs `pnpm --filter bot-host dev` and `pnpm --filter agent-core dev` in parallel using a portable pattern (npm-run-all2 or trap-based shell)
- `scripts/smoke.sh`: placeholder that exits 0 for now
- Root `scripts` in `package.json` working: `pnpm test`, `pnpm lint`, `pnpm build`

**Verify**:
```bash
pnpm test   # passes (no tests yet, but runner works)
pnpm lint   # passes
```

---

## Phase B — Protocol Package

### B1. Protocol types and schemas

**Prereq**: A2
**Deliverables**:
- `packages/protocol/package.json`: name `@feishu-bot/protocol`, depends on `zod` only, has `build` + `test` scripts
- `packages/protocol/tsconfig.json`
- `src/task.ts`, `src/messages.ts`, `src/errors.ts`, `src/schemas.ts`, `src/index.ts` — verbatim from SPEC §3

**Verify**:
```bash
pnpm --filter @feishu-bot/protocol build
# Expected: dist/ produced with .d.ts files
```

### B2. Protocol schema tests

**Prereq**: B1
**Deliverables**:
- `packages/protocol/src/schemas.test.ts`
- Tests must cover:
  - Valid `execute_task` request round-trips parse + serialize
  - Invalid `execute_task` (missing field, wrong type, empty text) → zod error
  - Valid `report_progress` notification for every `Phase` enum value
  - `cancel_task` with and without `reason`
  - Unknown method rejected by `inboundToAgentSchema`
  - Boundary: `text` at max length (8192) passes, 8193 fails
- At least 12 test cases

**Verify**:
```bash
pnpm --filter @feishu-bot/protocol test
# Expected: all tests pass
```

---

## Phase C — Bot Host (域外)

### C1. Bot-host config and logger

**Prereq**: B2
**Deliverables**:
- `packages/bot-host/package.json`: depends on `@feishu-bot/protocol` (workspace), `@larksuiteoapi/node-sdk`, `ws`, `better-sqlite3`, `pino`, `ulid`, `dotenv`, `zod`
- `src/config.ts`: loads `.env`, validates with zod (mirror the bot-host subset of SPEC §6), exports `frozen` config object, exits 1 on invalid
- `src/logger.ts`: pino instance with `service: "bot-host"` binding
- `src/main.ts`: skeleton that imports config, logs "bot-host starting", stays alive

**Verify**:
```bash
cd packages/bot-host && cp ../../.env.example .env && pnpm tsx src/main.ts
# Expected: logs "bot-host starting" and stays running; Ctrl+C to stop
```

### C2. SQLite storage layer

**Prereq**: C1
**Deliverables**:
- `src/storage/db.ts`: opens better-sqlite3 at `AUDIT_DB_PATH`, runs `CREATE TABLE IF NOT EXISTS` (SPEC §5)
- `src/storage/audit.ts`: `logAudit(entry)` signature from SPEC §5
- `src/storage/task-store.ts`: full API from SPEC §5 (createTask, updateStatus, setReplyMessageId, setResult, markOrphansOnBoot, getTask)
- Tests: `db.test.ts`, `audit.test.ts`, `task-store.test.ts` — use in-memory SQLite (`":memory:"`) per test
- `markOrphansOnBoot` test: insert 2 `queued` + 1 `done`, call function, assert 2 returned task_ids and their status is now `orphaned`

**Verify**:
```bash
pnpm --filter @feishu-bot/bot-host test storage
# Expected: all storage tests pass
```

### C3. Feishu client + event handler

**Prereq**: C2
**Deliverables**:
- `src/feishu/client.ts`: wraps `lark.WSClient` + `lark.Client` (for API calls), exports `start(onEvent)` that accepts a single message-received callback
- `src/feishu/handler.ts`: receives `P2ImMessageReceiveV1` event, returns `null` if: not group type, not @bot (check mentions for `FEISHU_BOT_OPEN_ID`), event_id already in dedup table. Otherwise returns a normalized `IncomingMessage` object: `{ event_id, chat_id, user_id, user_name, message_id, raw_text, ts }`
- Tests for `handler.ts` using fixture JSON events (stub the lark types, don't call real SDK)

**Verify**:
```bash
pnpm --filter @feishu-bot/bot-host test feishu
# Expected: handler tests pass; client test is allowed to be smoke-only (no creds)
```

### C4. Whitelist + parser + dedup

**Prereq**: C3
**Deliverables**:
- `src/router/whitelist.ts`: `isAllowed(chat_id, user_id): boolean` based on env config; reject audit entry is the caller's responsibility
- `src/router/parser.ts`: `normalizeInstruction(rawText): string | null` — strips all `<at>` blocks per SPEC §7.3, trims, returns `null` if residual < 2 chars
- Dedup uses `dedup_event` table; insert-or-ignore, then SELECT to check; cleanup old entries via TTL query (`DELETE WHERE seen_ts < now - 3600`) on each boot
- Tests for both modules

**Verify**:
```bash
pnpm --filter @feishu-bot/bot-host test router
# Expected: whitelist + parser tests pass
```

### C5. Dispatcher + Reply throttle

**Prereq**: C4
**Deliverables**:
- `src/feishu/reply.ts`:
  - `createInitialReply(task_id, chat_id, message_id): Promise<string>` — sends "🟡 [task_...] queued" as thread reply, returns the new message_id
  - `throttledUpdate(task_id, content): void` — buffers, calls `message.patch` at most once per `REPLY_THROTTLE_MS`; force-flush on final update
- `src/router/dispatcher.ts`:
  - `dispatch(msg: IncomingMessage): Promise<void>` — generates task_id (ULID), calls `createTask`, `createInitialReply`, stores reply_message_id, then calls `transport.sendExecuteTask` with progress callback that formats per SPEC §7.4 and passes to `throttledUpdate`
  - On final response: updates status, formats final message, force-flushes throttle
- Tests: dispatcher uses mocked transport + mocked reply; verify correct task_state transitions

**Verify**:
```bash
pnpm --filter @feishu-bot/bot-host test
# Expected: all bot-host tests pass
```

---

## Phase D — Agent Core (域内)

### D1. Agent-core config and WS server skeleton

**Prereq**: B2 (parallel with C1)
**Deliverables**:
- `packages/agent-core/package.json`: depends on `@feishu-bot/protocol` (workspace), `ws`, `pino`, `execa`, `dotenv`, `zod`
- `src/config.ts`, `src/logger.ts`: mirror structure from C1 but agent-core subset of env
- `src/server/ws-server.ts`:
  - Starts on `AGENT_WS_HOST:AGENT_WS_PORT`
  - Accepts exactly 1 client (reject subsequent with 1013)
  - Tracks `last_client_ts`; 45s watchdog closes with 1011
  - Exposes `sendNotification(method, params)` and `sendResponse(id, result|error)`
  - Emits `onRequest(method, id, params)` and `onNotification(method, params)` hooks
- `src/main.ts`: wires logger + server; handles `ping` locally (sends `pong`); stubs other methods to respond `-32601` for now

**Verify**:
```bash
cd packages/agent-core && cp ../../.env.example .env && pnpm tsx src/main.ts
# In another shell:
node -e "const WS=require('ws'); const s=new WS('ws://127.0.0.1:8765'); \
  s.on('open',()=>s.send(JSON.stringify({jsonrpc:'2.0',method:'ping',params:{ts:Date.now()}}))); \
  s.on('message',m=>console.log(m.toString()))"
# Expected: pong notification received within 1s
```

### D2. CodeExecutor interface + MockExecutor

**Prereq**: D1
**Deliverables**:
- `src/executor/types.ts`: exact interface from SPEC §4
- `src/executor/mock.ts`: deterministic timing:
  - Yield `{ phase: "planning", chunk: "收到: " + instruction, is_final: false }` immediately
  - Yield `{ phase: "editing", chunk: "mock 编辑中", is_final: false }` after 500ms
  - Yield `{ phase: "testing", chunk: "mock 测试中", is_final: false }` after another 500ms
  - Return `ExecutionResult { status: "success", summary: "mock 完成", branch: "ai/mock", files_changed: [] }`
  - Respects `signal.aborted`: on abort, yield `{ phase: "failed", chunk: "aborted", is_final: true }` then throw `AbortError`
- Tests: run to completion; test cancellation mid-run

**Verify**:
```bash
pnpm --filter @feishu-bot/agent-core test executor
# Expected: mock executor tests pass
```

### D3. TaskManager

**Prereq**: D2
**Deliverables**:
- `src/tasks/task-manager.ts`:
  - Constructor takes a `CodeExecutor` instance and max concurrency (from config)
  - `enqueue(request, send): Promise<void>` — validates slot, creates AbortController, runs executor, streams progress via `send`, sends final response
  - `cancel(task_id): boolean` — aborts controller if found
  - Maps executor exceptions to error codes per SPEC §11
- Wire into `ws-server.ts`: `onRequest("execute_task", ...)` → `taskManager.enqueue`
- Tests: integration using MockExecutor, verifying correct frame sequence

**Verify**:
```bash
pnpm --filter @feishu-bot/agent-core test
# Expected: all agent-core tests pass
```

### D4. Main wiring + dev script

**Prereq**: D3
**Deliverables**:
- `src/main.ts`: full wiring — select executor by `EXECUTOR_KIND` env (`mock` or `cursor`; fall back to mock if cursor not impl yet)
- Graceful shutdown: on SIGTERM/SIGINT, close server, cancel running tasks with 5s grace
- `packages/agent-core/package.json` scripts: `dev`: `tsx watch src/main.ts`, `build`: `tsc`, `start`: `node dist/main.js`

**Verify**:
```bash
pnpm --filter @feishu-bot/agent-core dev
# Expected: server starts, accepts connection, responds to ping + execute_task
```

---

## Phase E — Transport + Integration

### E1. WS client in bot-host

**Prereq**: C5 + D4
**Deliverables**:
- `packages/bot-host/src/transport/ws-client.ts`:
  - State machine from SPEC §9.1 (IDLE/CONNECTING/OPEN/BACKOFF)
  - `sendRequest<R>(req: OutboundRequest, onProgress: (ev) => void): Promise<R>`
  - Exponential backoff per SPEC §9.1
  - Heartbeat (ping every 15s, pong watchdog 45s)
  - Outbound queue capped at 100; overflow → reject with EXECUTOR_UNAVAILABLE
  - On reconnect: do **not** replay in-flight requests (they will be 15-min orphan-timeout'd and user will retry manually)
- Wire into bot-host `main.ts`: construct client, pass to dispatcher
- Tests: use an in-memory `ws` server fixture to simulate connect/disconnect/timeout

**Verify**:
```bash
pnpm --filter @feishu-bot/bot-host test transport
# Expected: ws-client tests pass (including reconnect scenario)
```

### E2. Orphan task recovery on boot

**Prereq**: E1
**Deliverables**:
- On bot-host startup: call `markOrphansOnBoot()`, for each returned task: send a Feishu message to the task's `chat_id` saying "⚠️ [task_xxxxxxxx] 上次该任务中断,请重新发送指令"
- Skip if task is > 24h old (stale data)
- Test this with fixture DB entries

**Verify**:
```bash
pnpm --filter @feishu-bot/bot-host test
# Expected: orphan recovery integration test passes (with mocked lark client)
```

### E3. End-to-end smoke test

**Prereq**: E2
**Deliverables**:
- `scripts/smoke.sh` replaces the placeholder with:
  1. Start agent-core (mock executor) in background, capture PID
  2. Wait for port 8765 to be LISTENING (timeout 10s)
  3. Start a temporary `tests/e2e/fake-feishu-driver.ts` in bot-host that: skips real Feishu SDK, directly calls `dispatcher.dispatch` with a fake `IncomingMessage`, asserts the task reaches `status=done` in DB within 15s, asserts the audit log has ≥ 4 entries (in, rpc_out, at least 1 rpc_in, out)
  4. Kill agent-core, clean up temp DB
  5. Exit 0 on success, non-zero + logs on failure
- Test uses mock executor only; no real Feishu, no Cursor

**Verify**:
```bash
pnpm smoke
# Expected: exits 0, no zombie processes left
```

---

## Phase F — Cursor Executor

### F1. CursorExecutor implementation

**Prereq**: E3
**Deliverables**:
- `packages/agent-core/src/executor/cursor.ts`:
  - Pre-flight checks per SPEC §4:
    - Workspace path exists and is a git repo
    - Working tree clean (else throw WORKSPACE_INVALID)
    - `cursor-agent` on PATH (else throw EXECUTOR_UNAVAILABLE)
  - Create branch `ai/${task_id.slice(-8)}` from current HEAD
  - Spawn via `execa`: `cursor-agent --prompt "${instruction}" --non-interactive` (exact flags TBD based on Cursor CLI current version — try `--help` first, adjust)
  - Capture stdout line-by-line, heuristically map to phases (contains "plan" → planning, contains "edit"/"writ" → editing, etc.; when unsure, pass as `editing` phase)
  - On process exit 0: collect changed files via `git diff --name-only main...HEAD`, return ExecutionResult with `status: "success"`
  - On exit ≠ 0 or timeout: throw with captured stderr tail
  - Always restore to original branch on completion (whether success or failure, branch remains but HEAD returns to main)
- Tests using `execa` mocks for happy path + failure path

**Verify**:
```bash
pnpm --filter @feishu-bot/agent-core test executor/cursor
# Expected: unit tests pass with mocked execa
```

### F2. Live Cursor CLI validation

**Prereq**: F1
**Deliverables**:
- `docs/CURSOR_SETUP.md`: how to install cursor-agent, authenticate, point EXECUTOR_WORKSPACE at a scratch repo
- Manual validation checklist (not automated — Claude Code documents the steps, the human runs them):
  1. With a scratch repo containing an intentionally buggy file, @bot with instruction "fix the null check in foo.ts"
  2. Observe progress updates arrive in Feishu
  3. After completion, verify branch `ai/xxx` exists with the fix committed
  4. Verify Feishu final message contains branch name
- Result of this task: the CURSOR_SETUP.md doc + a section in README pointing to it

**Verify**: Manual; Claude Code only produces the documentation.

---

## Phase G — Production Hardening

### G1. Build + systemd units

**Prereq**: F2
**Deliverables**:
- `pnpm build` at root produces `dist/` in every package with correct workspace resolution (bot-host's dist references `@feishu-bot/protocol` via workspace `file:` or `link:` protocol)
- `deploy/bot-host.service`:
  ```ini
  [Unit]
  Description=Feishu Coding Bot - Host (Domain External)
  After=network-online.target
  Wants=network-online.target

  [Service]
  Type=simple
  User=botuser
  WorkingDirectory=/opt/feishu-coding-bot
  EnvironmentFile=/opt/feishu-coding-bot/.env
  ExecStart=/usr/bin/node packages/bot-host/dist/main.js
  Restart=on-failure
  RestartSec=5
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  ```
- Analogous `deploy/agent-core.service`
- `deploy/install.md` with install/enable/start commands

**Verify**:
```bash
pnpm build
node packages/bot-host/dist/main.js    # starts correctly from built artifact
node packages/agent-core/dist/main.js  # same
```

### G2. README and developer docs

**Prereq**: G1
**Deliverables**:
- Expand `README.md` to cover:
  - Project overview (1 paragraph)
  - Prerequisites (Node, pnpm versions)
  - First-time setup: clone → `pnpm install` → `cp .env.example .env` → edit → `pnpm dev`
  - How to run tests
  - How to deploy (pointer to `deploy/install.md`)
  - Links to `docs/ARCHITECTURE.md`, `docs/SPEC.md`, `docs/TASKS.md`
  - Troubleshooting: top 5 expected issues (feishu perms, port conflict, workspace dirty, cursor CLI missing, USB link down)

**Verify**: Manual review.

---

## Definition of Done (Overall)

All of the following must be true for Phase 1 to be declared complete:

- [ ] `pnpm test` passes at root with zero failures
- [ ] `pnpm lint` passes with zero TS errors
- [ ] `pnpm build` produces runnable dist for all three packages
- [ ] `pnpm smoke` exits 0 using MockExecutor
- [ ] Manual Cursor CLI test (F2 checklist) passes end-to-end in a real Feishu group
- [ ] systemd units start and survive a `systemctl restart` cycle
- [ ] After a simulated 30s USB link drop, bot-host auto-reconnects and subsequent @mentions work
- [ ] After bot-host kill -9 + restart with a running task: user sees "上次任务中断" notification

---

## Execution Guidance for Claude Code

- **Do not skip ahead**: complete each task and verify before moving on. It is acceptable (and encouraged) to ask the human to run the verify command if it requires real credentials or network.
- **Do not invent tasks**: if something seems missing, ask first. Do not improvise major architectural additions.
- **Do not swap libraries**: versions are pinned in SPEC §1 for a reason. If a pinned library fails to install, report it — do not substitute.
- **Commit granularity**: one commit per task, message `[TASK-ID] short description`. Example: `[C2] add SQLite storage layer`.
- **Never bypass schemas**: every inbound WS message must pass through zod validation. No `as any` shortcuts.
