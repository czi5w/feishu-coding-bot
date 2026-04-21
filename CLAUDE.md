# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

The repository currently contains **design documents only** — no `package.json`, no `packages/`, no code. Phase A of `docs/TASKS.md` (repo bootstrap) has not been executed yet. Before writing any code, read the three canonical documents in full.

## Canonical Documents (source of truth)

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — macro architecture, component responsibilities, data flow, ADRs
- [docs/SPEC.md](docs/SPEC.md) — exact interface contracts, type definitions (copy verbatim), error codes, SQL schemas, env vars, pinned dependency versions
- [docs/TASKS.md](docs/TASKS.md) — 22 atomic tasks with dependency graph and per-task `Verify` commands
- [docs/CLAUDE.md](docs/CLAUDE.md) — detailed working rules (hard rules, code style, anti-patterns). Read this before any task.

**If code disagrees with `docs/SPEC.md`, the code is wrong.** Never modify SPEC to match buggy code.

## Project Overview

TypeScript monorepo bridging a Feishu group chat to a Cursor CLI running on an air-gapped internal machine, via WebSocket + JSON-RPC 2.0. Three planned packages:

- `@feishu-bot/protocol` — shared types + zod schemas (runtime validation of every WS frame). Zero runtime deps beyond zod.
- `@feishu-bot/bot-host` — external-side: Feishu long-polling adapter, whitelist, SQLite audit/task storage, WS **client**.
- `@feishu-bot/agent-core` — internal-side: WS **server**, `TaskManager`, `CodeExecutor` interface with `MockExecutor` + `CursorExecutor` implementations. **Stateless** — all persistence lives in bot-host.

Key topology facts that are non-obvious from code alone:
- External machine is the WS client (handles reconnect); internal machine is the WS server on port 8765.
- `request.id` **is** the business `task_id` (ULID) — do not allocate two IDs.
- One `execute_task` → N `report_progress` notifications + 1 response. `report_progress` carries `params.task_id` since notifications have no `id`.
- Phase 1 uses custom method names `execute_task` / `report_progress`; Phase 2 migrates to MCP `tools/call` / `notifications/progress`. **Do not pre-migrate.**
- `CursorExecutor` must always work on `ai/*` branches — never `main`/`master`. This is a hard safety rule enforced in code.

## Workflow

1. Pick the next task from `docs/TASKS.md` respecting the dependency graph (A1 → A2 → B1 → B2 → then C and D can run in parallel).
2. Re-read the referenced SPEC section and copy types **verbatim** — do not reinvent interfaces that SPEC already defines.
3. Implement, then run the task's `Verify` command. It must pass.
4. One commit per task: `[TASK-ID] imperative subject` (e.g. `[C2] add SQLite storage layer`). Branch: `claude/<task-id>-<slug>`.

## Commands (available only after Phase A tasks A1/A2 land)

```bash
pnpm install                              # bootstrap
pnpm dev                                  # run both bot-host and agent-core with tsx watch
pnpm build                                # pnpm -r build
pnpm test                                 # vitest run (all packages)
pnpm test:watch
pnpm lint                                 # tsc --noEmit against tsconfig.base.json
pnpm smoke                                # end-to-end smoke script

# Single package
pnpm --filter @feishu-bot/protocol test
pnpm --filter @feishu-bot/bot-host build

# Single test file / pattern
pnpm --filter @feishu-bot/bot-host test -- storage
pnpm exec vitest run path/to/file.test.ts
```

Pinned toolchain (see SPEC §1): Node `>=20.11.0 <21`, pnpm `>=9`, TypeScript `^5.4`, Vitest `^2`, zod `^3.23`, ws `^8.16`, `@larksuiteoapi/node-sdk` `^1.35`, better-sqlite3 `^11`, execa `^9`, pino `^9`. Do not swap a failing pinned version — report it.

## Hard Rules (from docs/CLAUDE.md — the full list is there)

- Use **pnpm**, not npm or yarn.
- Never use `any` / `as any`. Use `unknown` + zod parse.
- Validate every inbound WS message with zod schemas from `@feishu-bot/protocol`. Never `JSON.parse` a frame directly.
- Never redeclare a type that exists in `@feishu-bot/protocol`. Never mock that package in tests — import it.
- Relative imports must carry the `.js` extension (NodeNext): `import { foo } from "./bar.js"`.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on — handle `undefined` when indexing; use `prop?: T` rather than `prop: T | undefined`.
- Structured logging via pino: `log.info({ task_id }, "started")`, never string interpolation.
- Tests co-located (`foo.ts` ↔ `foo.test.ts`); cross-module integration tests in `tests/integration/`. Use `":memory:"` SQLite for unit tests.
- `CursorExecutor` must never touch `main`/`master` — hard-enforce in code.
