# Feishu Coding Bot — DEPRECATED

> **此仓库已停止维护。** 请使用新方案 [`ai-proxy-mcp`](../ai-proxy-mcp/)：
> - 飞书接入直接复用 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 0.6+ 自带的 `hermes-feishu` gateway
> - 任务调度交给 Hermes 的 LLM ReAct 循环
> - `ai-proxy-mcp` 只承担把 AI_Proxy 反向连接包装成 MCP 工具的职责
> - AI_Proxy C++ 端无需改动
>
> 详见 [`ai-proxy-mcp/README.md`](../ai-proxy-mcp/README.md) 和 [`ai-proxy-mcp/deploy/install.md`](../ai-proxy-mcp/deploy/install.md)。
>
> 以下原始 README 仅供历史参考。

---

> 把**飞书群聊里的自然语言指令**桥接到**域内电脑上的 Cursor CLI**——用户在白名单群 `@机器人` 提需求,域内的 Cursor Agent 自动执行变更并把进展实时回贴到原群的 thread。

[![Node](https://img.shields.io/badge/node-%3E%3D20.11.0%20%3C21-339933)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9-F69220)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-%5E5.4-3178C6)](https://www.typescriptlang.org/)

---

## 目录

- [项目背景](#项目背景)
- [系统架构](#系统架构)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [常用命令](#常用命令)
- [环境变量](#环境变量)
- [核心约定](#核心约定)
- [开发进度](#开发进度)
- [部署](#部署)
- [文档索引](#文档索引)
- [常见问题](#常见问题)

---

## 项目背景

公司有两台物理隔离的电脑:

- **域外机**:在公网办公网络,可以访问飞书 API,但**进不到内网代码仓库**。
- **域内机**:在受限内网,可以访问公司 Git 仓库 + 装着 `cursor-agent` CLI,但**出不了公网**。

两台机器之间用 USB 网卡直连(`192.168.100.0/24`)。本项目就是把这两端串起来:

```
飞书群 @bot "给 src/login.ts 加个 null check"
        ↓ (公网)
   域外 bot-host (Node.js)
        ↓ (USB 网卡, WebSocket + JSON-RPC 2.0)
   域内 agent-core (Node.js)
        ↓ (本地 spawn)
   cursor-agent CLI → 改代码 → 推 ai/* 分支
        ↑ (流式 progress 反向回流)
飞书群里看到 🟡 planning → 🟡 editing → ✅ done (48s) 分支: ai/abc12345
```

设计为**两阶段**:

- **Phase 1(当前)**:Feishu Bot ↔ Cursor CLI,自定义 method `execute_task` / `report_progress`。
- **Phase 2(规划)**:协议平滑升级到 MCP 标准(`tools/call` / `notifications/progress`),同一套 `CodeExecutor` 接口接入"座舱 C++ AI Agent"等更多执行器。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                  Feishu Open Platform                   │
└────────────────┬────────────────────────────────────────┘
                 │ Long-polling WebSocket (lark-oapi)
┌────────────────▼─────────────────────┐
│  [域外] @feishu-bot/bot-host         │
│  ┌─────────────────────────────────┐ │
│  │ Feishu Adapter — 事件订阅/回复  │ │
│  │ Router        — 白名单/解析/分派│ │
│  │ Transport     — WS 客户端       │ │
│  │ Storage       — SQLite 审计     │ │
│  └─────────────────────────────────┘ │
└──────────────┬───────────────────────┘
               │ JSON-RPC 2.0 over WebSocket
               │ (USB 链路, 默认端口 8765)
┌──────────────▼───────────────────────┐
│  [域内] @feishu-bot/agent-core       │
│  ┌─────────────────────────────────┐ │
│  │ WS Server     — 路由 JSON-RPC   │ │
│  │ TaskManager   — 生命周期/取消   │ │
│  │ CodeExecutor  ┬ MockExecutor    │ │
│  │               └ CursorExecutor ─┼─┐
│  └─────────────────────────────────┘ │ │
└──────────────────────────────────────┘ │
                                         ▼
                              spawn cursor-agent
```

**关键拓扑约定**:

| 项目 | 取值 |
|---|---|
| 默认 WS 端口 | `8765`(内网监听) |
| 连接方向 | 域外是 client、域内是 server(client 负责重连) |
| `request.id` | 直接使用业务 `task_id`(ULID,26 字符) |
| `report_progress` | JSON-RPC notification(无 `id`),靠 `params.task_id` 关联 |
| 持久化 | 仅域外侧(SQLite),域内**完全无状态**,重启即丢运行中任务 |
| AI 改代码的分支 | **始终** `ai/${task_id_last8}`,**禁止**直接写 `main`/`master`(代码层面硬约束) |

完整 ADR(架构决策记录)见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 仓库结构

```
feishu-coding-bot/
├── package.json                # root scripts + devDeps
├── pnpm-workspace.yaml         # 三个包的 workspace 配置
├── tsconfig.base.json          # 共享 TS 配置(strict + 严格 index 检查)
├── vitest.workspace.ts         # 跨包测试聚合
├── .env.example                # 环境变量模板(含完整注释)
├── docs/                       # 设计文档(单一事实来源)
│   ├── ARCHITECTURE.md         # 架构、组件职责、数据流、ADR
│   ├── SPEC.md                 # 接口契约、类型、错误码、SQL schema
│   ├── TASKS.md                # 22 个原子任务 + 依赖图 + 验证命令
│   └── CLAUDE.md               # Claude Code 工作规范
├── scripts/
│   ├── dev-all.sh              # 一键并行启动 bot-host + agent-core
│   └── smoke.sh                # 端到端冒烟(MockExecutor)
├── deploy/                     # systemd unit 模板(Phase G 输出)
└── packages/
    ├── protocol/               # @feishu-bot/protocol
    │   └── src/
    │       ├── task.ts         # TaskId / Phase / TaskContext
    │       ├── messages.ts     # JSON-RPC 信封 + 业务消息
    │       ├── errors.ts       # 错误码(JSON-RPC 标准 + 业务码)
    │       ├── schemas.ts      # zod 运行时校验 schema
    │       └── index.ts
    ├── bot-host/               # @feishu-bot/bot-host(域外)
    │   └── src/
    │       ├── main.ts         # 启动入口
    │       ├── config.ts       # zod 校验环境变量
    │       ├── logger.ts       # pino 实例(service: bot-host)
    │       ├── feishu/
    │       │   ├── client.ts   # lark.WSClient 封装
    │       │   ├── handler.ts  # 事件解析、@bot 过滤、去重
    │       │   └── reply.ts    # 回复 + 节流(2s 合并 patch)
    │       ├── router/
    │       │   ├── whitelist.ts
    │       │   ├── parser.ts   # 剥 <at> 标签
    │       │   ├── dispatcher.ts        # 任务编排
    │       │   └── orphan-recovery.ts   # 启动时恢复中断任务
    │       ├── transport/
    │       │   └── ws-client.ts # 状态机 + 指数退避重连 + 心跳
    │       └── storage/
    │           ├── db.ts        # better-sqlite3 + schema
    │           ├── audit.ts     # 审计日志写入
    │           ├── task-store.ts # 任务状态 CRUD
    │           └── dedup.ts     # event_id 去重表
    └── agent-core/             # @feishu-bot/agent-core(域内,Phase D 待实现)
        └── src/
            ├── main.ts
            ├── server/ws-server.ts
            ├── tasks/task-manager.ts
            └── executor/
                ├── types.ts    # CodeExecutor 接口
                ├── mock.ts     # MockExecutor(测试 + 联调用)
                └── cursor.ts   # CursorExecutor(spawn cursor-agent)
```

---

## 快速开始

### 前置条件

| 工具 | 版本 |
|---|---|
| Node.js | `>=20.11.0 <21`(20.x LTS,因 `better-sqlite3` 原生绑定锁版本) |
| pnpm | `>=9.0.0` |
| Git | 任意(域内机执行 Cursor 任务时会用) |
| cursor-agent | 仅域内机需要,Phase 1 联调可用 `MockExecutor` 跳过 |

### 三步起步

```bash
# 1. 安装依赖(workspace 协议自动连接三个包)
pnpm install

# 2. 配置环境
cp .env.example .env
# 编辑 .env,填入飞书 APP_ID/SECRET、白名单 chat/user open_id、内网 WS 地址

# 3. 一键启动两端(并行 tsx watch)
pnpm dev
```

启动后:

- bot-host 会订阅飞书事件、连接 `INNER_WS_URL`、初始化 SQLite。
- agent-core 在 `AGENT_WS_HOST:AGENT_WS_PORT` 监听。
- 默认 `EXECUTOR_KIND=mock`,任意 @bot 指令都会跑确定性的 mock 流程,看完整链路是否打通。

切到 `EXECUTOR_KIND=cursor` 之前,确认域内机已装好 `cursor-agent` 并指定一个干净的 git 仓库给 `EXECUTOR_WORKSPACE`。

---

## 常用命令

```bash
# 全仓
pnpm dev                                 # 并行起 bot-host + agent-core(tsx watch)
pnpm build                               # pnpm -r build,产物在每个包的 dist/
pnpm test                                # vitest 全量(三个包)
pnpm test:watch
pnpm lint                                # 各包跑 tsc --noEmit
pnpm smoke                               # 端到端冒烟(占位,E3 任务实现)

# 单包
pnpm --filter @feishu-bot/protocol build
pnpm --filter @feishu-bot/bot-host  test
pnpm --filter @feishu-bot/agent-core dev

# 单测试文件 / pattern
pnpm --filter @feishu-bot/bot-host test storage      # 跑名字含 storage 的
pnpm exec vitest run path/to/file.test.ts
```

---

## 环境变量

完整模板见 [`.env.example`](.env.example)。关键字段:

### 飞书(仅 bot-host 需要)

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书开放平台应用凭据 |
| `FEISHU_BOT_OPEN_ID` | 机器人自身的 open_id,用于校验 @ 是不是@到自己 |
| `ALLOWED_CHAT_IDS` | 逗号分隔的白名单群 chat_id |
| `ALLOWED_USER_IDS` | 逗号分隔的白名单用户 open_id |

### 传输

| 变量 | 默认 | 说明 |
|---|---|---|
| `INNER_WS_URL` | — | bot-host 连接的内网 WS 地址,如 `ws://192.168.100.2:8765` |
| `WS_RECONNECT_MIN_MS` / `MAX_MS` | 1000 / 60000 | 指数退避区间 |
| `WS_HEARTBEAT_MS` | 15000 | client 心跳间隔(server 端有 3× 看门狗) |
| `AGENT_WS_HOST` / `PORT` | `0.0.0.0` / `8765` | agent-core 监听地址 |

### 存储(bot-host)

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUDIT_DB_PATH` | `./data/audit.db` | SQLite 文件路径(自动建父目录) |

### 执行器(agent-core)

| 变量 | 默认 | 说明 |
|---|---|---|
| `EXECUTOR_KIND` | `mock` | `mock` 或 `cursor` |
| `EXECUTOR_WORKSPACE` | — | Cursor 工作的 git 仓库绝对路径 |
| `EXECUTOR_TIMEOUT_MS` | 600000 | 单任务超时(10 min,由 AbortController 强制) |
| `CURSOR_CLI_BINARY` | `cursor-agent` | 二进制名或绝对路径 |

### 运行时

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `info` | trace/debug/info/warn/error |
| `REPLY_THROTTLE_MS` | 2000 | 回贴节流窗口,2s 内的 progress 合并成一次 patch |
| `MAX_CONCURRENT_TASKS` | 1 | 并发上限,超出回 `-32007 CONCURRENCY_LIMIT` |

任何**必填项缺失启动直接 exit 1**,绝不静默失败。

---

## 核心约定

> 这些约束既写在 [docs/SPEC.md](docs/SPEC.md) 里,也散布在代码注释和 [docs/CLAUDE.md](docs/CLAUDE.md) 里。**修代码前先读它们。**

### 协议层

- 每条进出 WebSocket 的帧都必须经 `@feishu-bot/protocol` 的 zod schema 校验,**禁止**直接 `JSON.parse`。
- 一次 `execute_task` 的生命周期 = N 条 `report_progress` notification + 1 条 `execute_task` response。
- `report_progress` 没有 `id`,通过 `params.task_id` 找回路由。

### TypeScript 风格

- `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 全开。
- **禁用** `any` / `as any`;不确定的输入用 `unknown` + zod 解析。
- NodeNext 模块解析:相对 import 必须带 `.js` 后缀(`import { foo } from "./bar.js"`)。
- 文件名 `kebab-case.ts`,类型名 `PascalCase`,常量 `SCREAMING_SNAKE_CASE`。

### 日志

- 统一 pino 结构化日志,**不要**字符串拼接。
- 正确:`log.info({ task_id, phase }, "task progressed")`
- 错误:`log.info("task " + task_id + " progressed " + phase)`

### 测试

- 单测**与源码同目录**:`foo.ts` ↔ `foo.test.ts`。
- 跨模块集成测试放 `tests/integration/`。
- SQLite 测试一律用 `":memory:"`,绝不写到真实 `data/audit.db`。
- 只 mock 外部边界(lark SDK / ws / execa / better-sqlite3),**不要**mock 同包的内部模块——测不了说明设计有问题,该重构。
- 永远**不要**mock `@feishu-bot/protocol`——它是纯代码,直接 import。

### 安全 / 审计

- 域外 SQLite 落每条进出消息(`audit_log` 表),含拒绝条目。
- `.env` 权限 600,不进 git;飞书 SECRET 仅在 systemd `EnvironmentFile` 里。
- `CursorExecutor` 启动前会校验:工作树干净 + cursor-agent 在 PATH + 仓库是 git repo,任一不满足直接抛业务错误码。
- AI 产出**必须**推 `ai/*` 分支,代码层面硬编码这个约束,不留口子。

---

## 开发进度

按 [docs/TASKS.md](docs/TASKS.md) 的依赖图推进,共 22 个原子任务:

| Phase | 任务 | 状态 |
|---|---|---|
| **A** Repo 引导 | A1 monorepo 骨架 / A2 共享配置 + 脚本 | 完成 |
| **B** Protocol 包 | B1 类型 + schema / B2 schema 测试 | 完成 |
| **C** Bot Host(域外) | C1 config+logger / C2 SQLite / C3 飞书 client+handler / C4 白名单+解析+去重 / C5 dispatcher+回复节流 | 完成 |
| **D** Agent Core(域内) | D1 WS server / D2 CodeExecutor 接口+Mock / D3 TaskManager / D4 main 装配 | **待实现** |
| **E** 传输 + 联调 | E1 ws-client / E2 孤儿任务恢复 / E3 端到端冒烟 | E1/E2 完成,E3 待 Phase D |
| **F** Cursor Executor | F1 实现 / F2 真机验证 | 待 Phase D |
| **G** 生产硬化 | G1 systemd / G2 README+文档 | 待 |

`packages/agent-core/src/` 目前是空的,这是下一步要做的事——可以从 [docs/TASKS.md `D1` 任务](docs/TASKS.md) 开始。

---

## 部署

> 详细 systemd 配置在 [`deploy/`](deploy/)(Phase G 任务输出)。

生产环境拓扑:

| 组件 | 运行在 | 备注 |
|---|---|---|
| `bot-host` | 域外电脑(Ubuntu) | 24×7,合盖不睡眠/BIOS 通电自启 |
| `agent-core` | 域内电脑 | 同上,需要在防火墙开放 8765 入站(仅来自 `192.168.100.0/24`) |
| `cursor-agent` | 域内电脑 | 由 agent-core 按需 spawn |
| SQLite 文件 | 域外本地 | 单文件,定期 cron 归档(>90 天) |

构建 + 启动:

```bash
pnpm install --frozen-lockfile
pnpm build
node packages/bot-host/dist/main.js     # 域外
node packages/agent-core/dist/main.js   # 域内
```

systemd 托管下 stdout 走 journald,日志结构化(JSON)便于检索。

---

## 文档索引

| 文档 | 何时读 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 想理解整体拓扑、为什么这么分包、ADR 决策 |
| [docs/SPEC.md](docs/SPEC.md) | 写代码前——所有类型、错误码、SQL、env 都以这里为准 |
| [docs/TASKS.md](docs/TASKS.md) | 决定下一步做什么,以及怎么验证 |
| [docs/CLAUDE.md](docs/CLAUDE.md) | Claude Code 协作规范(硬规则、反模式、风格) |
| [CLAUDE.md](CLAUDE.md) | 仓库根的精简版工作守则 |

**铁律**:**代码与 `docs/SPEC.md` 不一致时,改代码,不改 SPEC。** SPEC 里写错了再单独提 issue 讨论改 SPEC。

---

## 常见问题

**Q1. 为什么 agent-core `src/` 是空的?**
A. Phase D 还没做。先按 [docs/TASKS.md](docs/TASKS.md) 的 `D1 → D2 → D3 → D4` 顺序起,每步都有 `Verify` 命令。

**Q2. `pnpm install` 装 `better-sqlite3` 失败?**
A. 99% 是 Node 版本不对——它有原生绑定,只锁 20.x LTS。检查 `node -v` 在 `>=20.11.0 <21` 范围。Windows 还需要 VS Build Tools。

**Q3. 端口 8765 被占用?**
A. 改 `.env` 的 `AGENT_WS_PORT` 和 `INNER_WS_URL` 同步改即可。这只是默认值,没硬编码。

**Q4. 飞书消息进来了但没反应?**
A. 检查顺序:
1. 看 bot-host 日志有没有 `"rejected non-whitelisted message"` —— `chat_id`/`user_id` 不在 `ALLOWED_*` 里。
2. 看有没有 `"skip message without @bot"` —— `FEISHU_BOT_OPEN_ID` 配错了。
3. 看 ws-client 状态 —— 内网 WS 没连上的话,执行任务会卡住。

**Q5. `cursor-agent` 报 `WORKSPACE_INVALID`?**
A. `EXECUTOR_WORKSPACE` 指的目录必须是干净的 git 仓库。有未提交改动 / 不是 git repo / 路径不存在,都会被预检查拒掉。这是为了避免 AI 把你本地改一半的代码搞乱。

**Q6. USB 网卡断开了 30s 会怎样?**
A. ws-client 状态机进入 `BACKOFF`,按指数退避(1s, 2s, 4s, …, 封顶 60s)重连。重连成功后**不会**重放正在飞的请求——它们会在 15 min orphan 超时后被 reject,用户需要重发指令。这是有意设计:网络抖动时确保不会重复执行。

---

## License

私有项目,未公开发布。

## Maintainer

chen ziqiang
