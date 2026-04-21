# Architecture — Feishu Coding Bot

> Phase 1: 域外 Feishu Bot + 域内 Agent Core + Cursor CLI 集成
> Stack: TypeScript (全栈) · pnpm workspace monorepo · WebSocket + JSON-RPC 2.0
> Owner: chen ziqiang · Last updated: 2026-04-20

---

## 1. System Goal

让用户在指定 Feishu 群 @ 机器人发出自然语言编程指令 → 域内电脑上的 Cursor CLI 自动执行 → 进展与结果回贴原群 thread。

整个系统通过 USB 网卡链路跨越域外/域内网络边界,协议层与 MCP 对齐,为第二阶段接入座舱 C++ AI Agent 做好接口准备。

---

## 2. System Boundaries

### In Scope (Phase 1)

- 域外 `bot-host`: Feishu 长连接事件订阅、白名单、任务队列、WebSocket 客户端、审计落盘
- 域内 `agent-core`: WebSocket 服务端、`CodeExecutor` 抽象、`MockExecutor` 实现、`CursorExecutor` 实现、任务生命周期管理
- 共享 `protocol` 包: JSON-RPC 消息类型、错误码、zod 运行时校验
- 端到端开发体验: 一键起双端、集成测试、systemd 部署模板

### Out of Scope (Phase 1)

- 第二阶段座舱 C++ AI Agent
- 车载 MCP 协议栈对接
- 多 IM 适配器(钉钉、企微)
- 任务优先级/配额(N→N 并发调度)
- 基于卡片的富交互回复(先做纯文本)
- 用户权限分级(只有白名单 on/off)

---

## 3. High-Level Topology

```
┌───────────────────────────────────────────────────────────────┐
│                    Feishu Open Platform                       │
└───────────────┬───────────────────────────────────────────────┘
                │ Long-polling WebSocket (lark-oapi)
                │
┌───────────────▼───────────────────────┐
│      [域外] bot-host                  │
│  ┌─────────────────────────────────┐  │
│  │  Feishu Adapter                 │  │
│  │  - 事件订阅 / @mention 解析     │  │
│  │  - 回复构造 / 节流              │  │
│  ├─────────────────────────────────┤  │
│  │  Router                         │  │
│  │  - 白名单 / 去重 / 指令归一化   │  │
│  │  - Task 生成与状态持久化        │  │
│  ├─────────────────────────────────┤  │
│  │  Transport (WS client)          │  │
│  │  - 指数退避重连 / 心跳          │  │
│  │  - id ↔ task_id 追踪            │  │
│  ├─────────────────────────────────┤  │
│  │  Storage (SQLite)               │  │
│  │  - audit_log / task_state       │  │
│  └─────────────────────────────────┘  │
└────────────┬──────────────────────────┘
             │
             │ JSON-RPC 2.0 over WebSocket
             │ (USB 网卡链路, 192.168.100.0/24)
             │
┌────────────▼──────────────────────────┐
│      [域内] agent-core                │
│  ┌─────────────────────────────────┐  │
│  │  WS Server                      │  │
│  │  - 连接管理 / 心跳              │  │
│  │  - JSON-RPC 路由                │  │
│  ├─────────────────────────────────┤  │
│  │  TaskManager                    │  │
│  │  - 生命周期 / 并发控制 / 取消   │  │
│  │  - progress stream 转发         │  │
│  ├─────────────────────────────────┤  │
│  │  CodeExecutor (interface)       │  │
│  │  ├── MockExecutor               │  │
│  │  └── CursorExecutor ─────────┐  │  │
│  └──────────────────────────────│──┘  │
└─────────────────────────────────│─────┘
                                  │ spawn subprocess
                                  ▼
                          cursor-agent CLI
```

---

## 4. Repository Structure

Monorepo managed by pnpm workspaces. 三个 package,内部 import 走 workspace 协议。

```
feishu-coding-bot/
├── package.json                  # root scripts, devDeps only
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json            # shared TS config
├── vitest.workspace.ts           # 聚合所有包的测试
├── .env.example
├── .gitignore
├── README.md
├── CLAUDE.md                     # Claude Code 工作规范
├── docs/
│   ├── ARCHITECTURE.md           # 本文件
│   ├── SPEC.md                   # 接口规格
│   └── TASKS.md                  # 原子任务列表
├── scripts/
│   ├── dev-all.sh                # 一键起双端(tsx watch)
│   └── smoke.sh                  # 端到端冒烟
├── packages/
│   ├── protocol/                 # @feishu-bot/protocol
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── messages.ts       # JSON-RPC envelope + 业务消息
│   │       ├── errors.ts         # 错误码表
│   │       ├── schemas.ts        # zod runtime schemas
│   │       └── task.ts           # Task / Phase / ProgressEvent
│   ├── bot-host/                 # @feishu-bot/bot-host
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main.ts
│   │       ├── config.ts
│   │       ├── feishu/
│   │       │   ├── client.ts
│   │       │   ├── handler.ts
│   │       │   └── reply.ts
│   │       ├── router/
│   │       │   ├── whitelist.ts
│   │       │   ├── parser.ts
│   │       │   └── dispatcher.ts
│   │       ├── transport/
│   │       │   └── ws-client.ts
│   │       └── storage/
│   │           ├── db.ts
│   │           ├── audit.ts
│   │           └── task-store.ts
│   └── agent-core/               # @feishu-bot/agent-core
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── main.ts
│           ├── config.ts
│           ├── server/
│           │   └── ws-server.ts
│           ├── tasks/
│           │   └── task-manager.ts
│           └── executor/
│               ├── types.ts      # CodeExecutor interface
│               ├── mock.ts       # MockExecutor
│               └── cursor.ts     # CursorExecutor
└── deploy/
    ├── bot-host.service
    ├── agent-core.service
    └── install.md
```

---

## 5. Component Responsibilities

### 5.1 `@feishu-bot/protocol` (共享协议包)

**职责**: 定义跨进程的所有数据结构和错误码。**零运行时依赖**(仅 `zod`)。

- TypeScript types: 编译期类型
- Zod schemas: 运行时校验(每条进出 WS 的消息必须通过 zod 解析)
- 错误码常量和工厂函数

**关键约束**: 这个包被两端同时 import,任何改动都是**双端同时生效**的 breaking change,所以改动前必须先改 SPEC.md,然后再改代码。

### 5.2 `@feishu-bot/bot-host` (域外)

**职责**: 桥接 Feishu 群聊和域内 agent-core。纯 I/O,无业务逻辑。

子模块:

| 模块 | 职责 |
|---|---|
| `feishu/client` | `lark-oapi` 客户端封装,长连接订阅 |
| `feishu/handler` | 事件回调入口,过滤非群消息、非 @bot 消息 |
| `feishu/reply` | 消息发送、节流(2s 合并 edit) |
| `router/whitelist` | `chat_id` + `user_id` 白名单校验 |
| `router/parser` | 剥离 `<at>` 标签,归一化文本 |
| `router/dispatcher` | 生成 task → 持久化 → 推 transport → 订阅进展回复 |
| `transport/ws-client` | 连接 agent-core,指数退避,id 追踪 |
| `storage/db` | SQLite 初始化(better-sqlite3) |
| `storage/audit` | 进出消息落盘 |
| `storage/task-store` | 任务状态持久化(含重启恢复) |

### 5.3 `@feishu-bot/agent-core` (域内)

**职责**: 接收任务、调 executor、推流式进展、返回结果。

子模块:

| 模块 | 职责 |
|---|---|
| `server/ws-server` | `ws` 库启动 server,JSON-RPC 路由 |
| `tasks/task-manager` | 任务生命周期、并发控制(默认 max=1)、cancel |
| `executor/types` | `CodeExecutor` 接口定义 |
| `executor/mock` | 确定性 sleep + fixed output,用于联调 |
| `executor/cursor` | `execa` spawn `cursor-agent`,解析流式输出 |

**CodeExecutor 的扩展策略**: 新 executor 只需实现 `types.ts` 里的接口并在 `main.ts` 里注册。Phase 2 的"车载技能 executor"就是这种模式加进来。

---

## 6. Data Flow — Happy Path

用户在群里发 `@bot 给 src/login.ts 的 handleLogin 加个 null check`:

```
1.  Feishu event (im.message.receive_v1)
    │
    ▼
2.  bot-host: feishu/handler
    ├─ 过滤: chat_type=group && @bot
    ├─ 去重: event_id 近1小时 LRU
    └─ 交给 router
    │
    ▼
3.  bot-host: router/whitelist
    └─ chat_id & user_id 白名单校验 → 通过
    │
    ▼
4.  bot-host: router/parser
    └─ 剥 <at>,trim → "给 src/login.ts 的 handleLogin 加个 null check"
    │
    ▼
5.  bot-host: router/dispatcher
    ├─ 生成 ULID task_id
    ├─ INSERT audit_log (direction='in', task_id=...)
    ├─ INSERT task_state (status='queued')
    └─ 送入 transport
    │
    ▼
6.  bot-host: transport/ws-client
    └─ 发送 JSON-RPC request:
       { id: task_id, method: "execute_task", params: {...} }
    │
    ▼
7.  agent-core: server/ws-server
    └─ 路由 execute_task → TaskManager.enqueue
    │
    ▼
8.  agent-core: tasks/task-manager
    ├─ 拿到并发 slot (默认 max=1, 其他排队)
    ├─ 调 CursorExecutor.execute(ctx)
    └─ 订阅 AsyncIterable<ProgressEvent>
    │
    ▼
9.  agent-core: executor/cursor
    ├─ execa spawn cursor-agent
    ├─ 解析 stdout chunk 为 phase
    └─ yield ProgressEvent { phase, chunk, is_final }
    │
    ▼
10. agent-core → bot-host (每个 ProgressEvent 发一条 notification):
       { method: "report_progress", params: {...} }  ← 无 id
    │
    ▼
11. bot-host: transport/ws-client
    └─ 转发给 dispatcher 的 progress 回调
    │
    ▼
12. bot-host: router/dispatcher + feishu/reply
    ├─ INSERT audit_log (direction='out', task_id=...)
    ├─ 节流器 coalesce (2s 窗口)
    └─ lark client edit message (首次是 send)
    │
    ▼
13. agent-core: 最终结果
    └─ 发送 JSON-RPC response:
       { id: task_id, result: { status: "success", branch: "..." } }
    │
    ▼
14. bot-host: 结束
    ├─ UPDATE task_state SET status='done'
    ├─ 最后一次 edit message,追加结果 summary
    └─ 流程结束
```

---

## 7. Protocol Contract (Overview)

详细 schema 见 `SPEC.md §3`。这里只说约束和语义。

### Transport

- WebSocket over TCP,默认端口 **8765**
- 文本帧,UTF-8 编码,单帧 ≤ 64 KiB
- 双向长连接,域外是 client,域内是 server
- 心跳: client 每 15s 发 JSON-RPC notification `ping`,server 回 `pong`
- 断开: 任一端异常关闭,client 按指数退避重连(1s, 2s, 4s, ..., 封顶 60s)

### Message Shape (JSON-RPC 2.0)

| 方向 | 类型 | `id` | 用途 |
|---|---|---|---|
| 外 → 内 | request | ULID task_id | `execute_task`, `cancel_task` |
| 外 → 内 | notification | — | `ping` |
| 内 → 外 | response | 对齐 request.id | 任务最终结果 |
| 内 → 外 | notification | — | `report_progress`, `pong` |

**关键约定**:
1. `request.id` 同时就是业务 `task_id`,不分两个 ID
2. `report_progress` 是 notification(无 `id`),携带 `params.task_id` 标识归属
3. 一个 `execute_task` 的生命周期: N 条 `report_progress` notifications + 1 条 `execute_task` response
4. `report_progress` 可以在 response 前任意时机到达,但 response 到达后,对应 task_id 不再有 progress

---

## 8. Persistence Model

仅域外侧有持久化,域内侧无状态(重启即失)。

### `audit_log` (每条进出消息)

- 主键自增 id + ts
- `direction`: `in` (Feishu→bot) / `out` (bot→Feishu) / `reject` (非白名单) / `rpc_out` (bot→agent) / `rpc_in` (agent→bot)
- `task_id` 可空(比如 reject 时没有 task)
- `raw_text` + `extra` (JSON, 灵活字段)

### `task_state` (每个业务任务)

- 主键 `task_id` (ULID)
- `status`: `queued` / `running` / `done` / `failed` / `cancelled` / `orphaned`
- `request_json`, `result_json`
- 启动时扫描 `status IN ('queued','running')` 的,全部标为 `orphaned`,并推送"上次这个任务中断"通知到对应 chat

详细 schema 见 `SPEC.md §5`。

---

## 9. Runtime & Deployment

### Development

- `pnpm dev` 在 monorepo root 并行跑两端(tsx watch)
- `.env` 本地读取,`.env.example` 带完整注释
- Vitest watch 模式 + 端到端脚本 `scripts/smoke.sh`

### Production

- `pnpm build` 编译所有包到各自 `dist/`
- `node dist/main.js` 启动,由 systemd 托管
- 单文件 SQLite 数据库,每月 cron 归档(超 90 天)
- 日志用 pino,JSON 格式,stdout,由 journald 收集

### Topology

| 组件 | 运行在 | 常开 | 备注 |
|---|---|---|---|
| bot-host | 域外电脑 (Ubuntu) | ✅ 24×7 | 合盖不睡眠/BIOS 通电自启 |
| agent-core | 域内电脑 | ✅ 24×7 | 同上 |
| cursor-agent | 域内电脑 | 按需 spawn | 由 agent-core 托管 |
| SQLite | 域外本地文件 | N/A | 定期归档 |

---

## 10. Architecture Decision Records

### ADR-001: 全栈 TypeScript

- **Status**: Accepted
- **Context**: 曾考虑 Python / C++ 混合栈
- **Decision**: 域外 + 域内 + 协议全部 TypeScript
- **Rationale**: 协议类型可跨域共享;Claude Code 在 TS 上一次成功率最高;异步/流式语义 Promise + AsyncIterable 表达自然;飞书官方 Node SDK 满足需求
- **Consequences**: 第二阶段座舱 C++ 需要独立设计一次 MCP 协议适配层,但这本就是独立的产品线

### ADR-002: Monorepo with pnpm workspace

- **Decision**: 三个 package 放一个仓库,通过 pnpm workspace 协议互引
- **Rationale**: `protocol` 包被双端共享,分仓会引入 npm link / 发版时序问题;monorepo 下改协议+改双端可在一次 PR 内完成

### ADR-003: JSON-RPC 2.0 over WebSocket

- **Decision**: 应用层协议固定为 JSON-RPC 2.0,载体 WebSocket
- **Rationale**: 与 MCP 底层协议同源,第二阶段升级零迁移;双向流式天然契合;工具链成熟
- **Alternatives rejected**: 裸 TCP(需自研分帧/ID关联)、gRPC(引入 Protobuf,跨域 schema 演进成本高)、HTTP long-polling(反模式)

### ADR-004: CodeExecutor 抽象接口

- **Decision**: 域内侧定义 `CodeExecutor` 接口,Cursor CLI 是首个实现
- **Rationale**: Cursor 官方 CLI 尚在快速迭代,接口抽象隔离变化;为第二阶段车载技能 executor 预留扩展点
- **Consequences**: 必须有 `MockExecutor`,否则集成测试无法离线运行

### ADR-005: 域外客户端、域内服务端

- **Decision**: WebSocket 方向由域外向域内发起
- **Rationale**: 域外办公机更易休眠/网络抖动,客户端承担重连逻辑更合理;域内机期望稳定常驻
- **Consequences**: 域内需要固定监听端口;防火墙配置需要在域内允许 8765 入站(仅从 192.168.100.0/24)

### ADR-006: 域内无状态,所有持久化在域外

- **Decision**: agent-core 重启即丢运行中任务,不做状态恢复
- **Rationale**: 任务的真实归属方(Feishu 回复目标)在域外,域外重启恢复已足够;避免双端状态一致性问题
- **Consequences**: 域内重启时正在跑的任务变成 `orphaned`,域外需要有通知机制

### ADR-007: SQLite 而非更重的数据库

- **Decision**: 域外持久化用 better-sqlite3
- **Rationale**: 单机、单进程、写入量小(每日 <10k 行);零运维;备份就是复制单个文件
- **Consequences**: 不支持多进程并发写(bot-host 必须单实例)

---

## 11. Security & Audit Model

### 威胁模型

- **外部**: 攻击者无法到达 WebSocket 端口(域内网络隔离)
- **Feishu 侧**: 非白名单群/用户的消息一律拒绝;依赖飞书平台身份
- **内部审计**: 每条进出消息本地 SQLite 落盘,用于事后追溯

### 非目标

- 不做端到端加密(依赖 USB 网卡链路物理安全)
- 不做 user authorization 分级(白名单粒度足够)
- 不防内部人员滥用(监控节点/gong ke 负责)

### 强制约束

- AI 产出的代码变更**必须**推送到独立分支,**禁止**直接修改主干(在 `CursorExecutor` 中硬编码)
- `.env` 文件权限 600,不进 git
- 飞书 APP_SECRET 仅在 systemd `EnvironmentFile` 中存在,不 echo 到日志

---

## 12. Phase 2 Migration Path

第一阶段的设计为第二阶段留了三个扩展点:

1. **协议升级**: `execute_task` / `report_progress` 无缝升级为 MCP `tools/call` / `notifications/progress`
2. **新 Executor**: 座舱侧车载技能(开门/空调/导航)实现 `CodeExecutor` 接口即可接入(语义上是"Task Executor"更准确,名字后续再改)
3. **多 Agent 路由**: `bot-host/router/dispatcher` 增加一层路由逻辑,按指令类型分派到不同 agent-core 实例

第二阶段不需要重写的代码:
- `@feishu-bot/protocol` 95% 保留,仅 method name 从业务名换成 MCP 标准名
- `@feishu-bot/bot-host` 全部保留
- `@feishu-bot/agent-core` 的 server/tasks/executor interface 保留,executor 实现扩充

---

## 13. Glossary

| 术语 | 含义 |
|---|---|
| 域外 | 公网侧,办公网络,能访问 Feishu API |
| 域内 | 受限内网,能访问公司代码仓库,不能直接访问公网 |
| USB 网卡链路 | 双机通过 USB 转网卡直连的物理链路,IP 段 192.168.100.0/24 |
| Task | 用户一条 @ 指令对应一个 task,有唯一 ULID task_id |
| Phase | 任务生命周期的阶段: queued / planning / editing / testing / done / failed |
| Executor | 执行具体代码变更的后端,Phase 1 仅 Cursor CLI |
| MCP | Model Context Protocol,Anthropic 制定的 LLM tool 协议,JSON-RPC 2.0 based |
