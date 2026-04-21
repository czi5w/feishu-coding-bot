# CLAUDE.md

> This file configures Claude Code's behavior in this repository.
> Read this file in full before taking any action.

## Project Summary

Feishu Coding Bot — a TypeScript monorepo that bridges Feishu group chat to a Cursor CLI running on an internal (air-gapped) machine via WebSocket + JSON-RPC 2.0. Users @ the bot in a whitelisted group with natural-language instructions; a Cursor agent on the internal machine makes the requested code changes and reports progress back to the group.

Three packages:
- `@feishu-bot/protocol` — shared types + zod schemas (zero runtime deps beyond zod)
- `@feishu-bot/bot-host` — external-side Feishu adapter + WS client
- `@feishu-bot/agent-core` — internal-side WS server + CodeExecutor (Cursor CLI)

## Canonical Documents

These are the source of truth. When in doubt, re-read them.

- `docs/ARCHITECTURE.md` — macro architecture, component responsibilities, data flow, ADRs
- `docs/SPEC.md` — exact interface contracts, type definitions, error codes, SQL schemas, env vars
- `docs/TASKS.md` — atomic tasks with dependencies and verification commands

**If `docs/SPEC.md` disagrees with the code, the code is wrong.** Never modify SPEC.md to match buggy code — fix the code.

## How to Work

### Task Execution

1. Identify the next task from `docs/TASKS.md` (respect the dependency graph).
2. Re-read the task's "Deliverables" section. Re-read any referenced SPEC section.
3. Implement.
4. Run the task's "Verify" command. It must pass before you consider the task done.
5. Commit: `[TASK-ID] short description`. One commit per task.
6. Move to the next task.

### Before Starting Any Task

Ask yourself:
- Have I re-read the relevant `docs/SPEC.md` section for the types I'm about to write?
- Am I about to invent an interface that SPEC already defines? (If yes, use the SPEC one verbatim.)
- Does this task have prerequisites in `docs/TASKS.md`? Are they done?

### When You Encounter Ambiguity

**Stop and ask the human.** Do not guess. Common ambiguity triggers:

- SPEC says "roughly" or "approximately" — ask for the exact value
- A library has multiple API styles (callback vs promise vs event-emitter) — ask which
- A test case is underspecified — ask
- An error code isn't mapped in SPEC §11 — ask

Better to pause 2 minutes than to commit code that gets reverted.

## Hard Rules

### Must Do

1. **Use pnpm, not npm or yarn.** Always.
2. **Validate all inbound WS messages with zod schemas from `@feishu-bot/protocol`.** No exceptions.
3. **Use `@feishu-bot/protocol` types across all packages.** Never redeclare types that already exist there.
4. **Write tests co-located with source**: `foo.ts` → `foo.test.ts` (unit); `tests/integration/` for cross-module.
5. **Commit after each task.** Never bundle multiple tasks into one commit.
6. **Use structured logging via pino.** Pass objects, not interpolated strings: `log.info({ task_id }, "started")` not `log.info("started " + task_id)`.
7. **Respect pinned versions in `docs/SPEC.md` §1.** If a version fails, report it; do not swap.
8. **Honor the `AbortSignal` everywhere it's passed.** Long-running operations must check for abort.

### Must Not Do

1. **Never use `any` or `as any`.** If a type is hard to express, use `unknown` + zod parse.
2. **Never modify a built-in Node prototype or global.**
3. **Never commit secrets or `.env` files.** Only `.env.example` is tracked.
4. **Never add a new production dependency without approval.** DevDependencies for testing are fine.
5. **Never skip a task's verify step.** If the verify command can't run in your environment (e.g., needs Feishu creds), ask the human to run it and paste the result.
6. **Never create files outside the package's `src/`, `tests/`, or repo root.** No `.claude/` or scratch directories committed.
7. **Never mock `@feishu-bot/protocol`.** It's pure code; if tests need it, import it.
8. **Never touch `main`/`master` directly in a CursorExecutor run.** Always work on `ai/*` branches. This is a hard safety rule enforced in code.

## Code Style

- TypeScript strict mode everywhere (see `tsconfig.base.json`).
- `noUncheckedIndexedAccess: true` — handle `undefined` explicitly when indexing arrays/records.
- `exactOptionalPropertyTypes: true` — use `prop?: T` intentionally; don't set `prop: undefined`.
- Prefer named exports; default exports only when the file exports exactly one thing.
- Import with explicit `.js` extensions (NodeNext module resolution): `import { foo } from "./bar.js"`.
- No `I`-prefix on interfaces (`UserRecord`, not `IUserRecord`).
- File names: `kebab-case.ts`. Type names: `PascalCase`. Variables/functions: `camelCase`. Constants: `SCREAMING_SNAKE_CASE`.
- Async iterators: prefer `for await (const x of ...)` over `.next()` calls.

## Testing

- Framework: Vitest (already configured).
- Run all: `pnpm test` (at root). Single package: `pnpm --filter <pkg> test`. Watch: `pnpm test:watch`.
- Use `":memory:"` SQLite for unit tests; do not touch the real `data/audit.db`.
- Mock external boundaries only (`lark-oapi`, `ws`, `execa`, `better-sqlite3`).
- **Never mock internal modules of the same package** — if it's hard to test, the design is wrong; refactor.
- Each exported function in core modules (parser, router, task-manager, ws-client, executors) needs at least one test.

## Commits and Branches

- Commit message format: `[TASK-ID] subject line` where TASK-ID is from `docs/TASKS.md` (e.g., `[C2]`, `[E3]`).
- Subject ≤ 72 chars, imperative mood: "add X", "fix Y", not "added X".
- If a task produces more than one logical change, still one commit — use bullet points in the commit body.
- Branch naming: `claude/<task-id>-<slug>`. Example: `claude/c2-sqlite-storage`.
- Do not merge to `main` yourself. Open a PR or leave the branch for the human to review.

## Environment Assumptions

- OS: Linux (Ubuntu 22.04+). Code must not depend on Linux-only APIs if there's a portable alternative.
- Node: 20.x LTS (exact range in SPEC §1).
- No Docker expected. Processes run directly on the host under systemd in production.
- `cursor-agent` may or may not be installed in your environment — use `MockExecutor` for all automated tests.

## When You Finish a Task

Report to the human with:
1. Task ID and title
2. Files created/modified (list)
3. Verify command and its output (tail if long)
4. Any deviations from SPEC and why
5. What the next task is per the dependency graph

Example:
```
Done: [C2] SQLite storage layer.
Files: packages/bot-host/src/storage/{db,audit,task-store}.ts + tests.
Verified: `pnpm --filter @feishu-bot/bot-host test storage` → 14 passed.
Deviations: none.
Next: C3 (Feishu client + handler).
```

## When You Get Stuck

In order:
1. Re-read the relevant SPEC section.
2. Re-read the TASK deliverables and verify command.
3. Check if `docs/ARCHITECTURE.md` explains the *why*.
4. If still stuck: stop, describe the blocker to the human, propose 2-3 options. Do not make a silent decision.

## Anti-Patterns Specific to This Codebase

Observed failure modes in past attempts:

- **Mixing protocol method names with their MCP equivalents**. Phase 1 uses `execute_task` / `report_progress` (not `tools/call` / `notifications/progress`). Phase 2 will migrate. Do not pre-migrate.
- **Re-declaring the JSON-RPC envelope type in each package**. There is one definition, in `@feishu-bot/protocol`. Use it.
- **Using `JSON.parse` directly on WS frames**. Always go through the zod schema that already wraps `JSON.parse` + validation.
- **Forgetting the `.js` extension on relative imports**. NodeNext requires it. `import "./foo"` will not work; `import "./foo.js"` will.
- **Writing `async function* foo(): AsyncIterable<T>`** when you mean `AsyncGenerator<T, R, void>`. They are not the same — the latter carries a return type which the CodeExecutor interface requires.
- **Setting exit codes by writing to `process.exitCode` but then also calling `process.exit()`**. Pick one; prefer `process.exit()` at the top-level shutdown handler, never deep in module code.

## Final Reminder

The human has invested significant effort in the design documents. The best thing you can do is follow them precisely, move fast on the clear parts, and ask crisp questions on the unclear parts. Avoid the temptation to "improve" the architecture mid-implementation — that goes in an issue for later, not in the current PR.
