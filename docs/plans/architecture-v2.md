# AnyWork V2 架构设计

> 开源云原生 AI Agent 调度与执行引擎

## 1. 定位

AnyWork 是一个 **调度和执行引擎**，不是用户平台。

- 接收 TaskRequest，调度 Worker Pod，执行 Agent 任务，返回结果
- 不管用户体系、鉴权、计费 — 这些交给上层产品
- 支持 Interactive（Web Chat）和 Oneshot（事件触发）两种模式
- 统一 codebase，通过配置切换部署级别

## 2. 核心概念模型

```
Channel → Task → Worker → MCP/Skills
```

| 概念 | 说明 |
|------|------|
| **Channel** | 事件入口：webchat、github、slack… 负责验签、翻译格式、声明默认 skill/MCP |
| **Task** | 单次请求-响应，调度和可观测的基本单位 |
| **Session** | 执行环境，提供 workspace 和对话历史延续 |
| **Worker** | 隔离的计算容器，运行 Claude Agent SDK |
| **Skill** | Agent Skills 开放标准（agentskills.io），SKILL.md 格式 |
| **MCP** | Model Context Protocol，Agent 与外部系统的标准桥接 |

## 3. 数据模型

### 3.1 实体关系

```
Session  1 ──── N  Task  1 ──── N  TaskLog
 (环境)           (单次执行)        (执行过程)
```

### 3.2 Session — 执行环境

Session 是一个持久化的上下文环境，提供：
- 一个 workspace（`/workspace/`，文件、技能目录）
- 一段对话历史（Claude Agent SDK 通过 session resume 延续）
- 一个 Worker Pod 路由（同 session 复用同一个 Pod）

```typescript
interface Session {
  id: string;              // 调用方定义，anywork 不解读
  channelType: string;     // 创建此 session 的 channel
  title?: string;          // 可选，方便展示
  createdAt: number;
  lastActiveAt: number;
}
```

**没有 userId** — anywork 不管用户身份。sessionId 由调用方定义，可以是 PR 编号、Slack thread ID、自定义 UUID。anywork 只用它做路由和上下文分组。

### 3.3 Task — 单次执行

每一次"用户发消息 / webhook 推事件"，都创建一个 Task：

```typescript
type TaskStatus =
  | "pending"          // 已创建，等待调度
  | "running"          // Worker 执行中
  | "input_required"   // Agent 需要补充输入（借鉴 A2A 协议）
  | "completed"        // 成功
  | "failed"           // 失败
  | "canceled";        // 用户取消（借鉴 A2A 协议）

interface TaskRecord {
  id: string;
  sessionId: string;
  channelType: string;
  channelMeta: object;         // channel 透传的上下文（PR URL、issue 号等）

  status: TaskStatus;
  message: string;             // 触发输入
  skills: string[];            // 本次 task 使用的 SkillRef[]
  mcpServers: string[];        // 本次 task 使用的 MCP 名称

  // 产出（直接对应 Claude Agent SDK ResultMessage）
  result?: string;             // SDKResultMessage.result
  structuredOutput?: any;      // SDKResultMessage.structured_output
  error?: string;              // 失败原因

  // 执行统计（SDK 直接提供）
  costUsd?: number;            // total_cost_usd
  numTurns?: number;           // num_turns
  durationMs?: number;         // duration_ms

  // 完成通知（借鉴 A2A Push Notification）
  pushNotification?: {
    webhookUrl: string;
    authHeader?: string;
    events?: string[];
  };

  workerId?: string;           // Pod name / container ID
  createdAt: number;
  startedAt?: number;          // pending → running
  finishedAt?: number;         // → completed / failed / canceled
}
```

### 3.4 TaskLog — 执行过程

Agent 工作过程中产出的每一步记录：

```typescript
interface TaskLogEntry {
  taskId: string;
  seq: number;              // 递增序号，用于增量拉取
  type: "text" | "tool_call" | "tool_result" | "error" | "done";
  content: string;
  metadata?: object;        // tool name、duration 等
  timestamp: number;
}
```

### 3.5 多轮对话示例

**Web Chat：**

```
Session "s-001"
├── Task 1: "帮我写一个排序函数"     → completed
│   ├── log: text "好的，我来写..."
│   ├── log: tool_call Write("sort.py")
│   └── result: "已创建 sort.py"
├── Task 2: "加上单元测试"           → completed
│   ├── log: tool_call Read("sort.py")
│   ├── log: tool_call Write("test_sort.py")
│   └── result: "3 个测试全部通过"
└── Task 3: "性能怎么样？"           → running
```

Task 2 能看到 Task 1 写的文件，因为它们共享 Session（同一个 workspace + Claude SDK session resume）。

**GitHub Oneshot：**

```
Session "gh-pr-789"                  ← 一个 PR = 一个 Session
├── Task 1: PR opened → review      → completed
└── Task 2: new commit → re-review  → completed
```

### 3.6 数据库 Schema

```sql
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL DEFAULT 'webchat',
  title        TEXT,
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL
);

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  channel_type      TEXT NOT NULL,
  channel_meta      TEXT DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending',
  message           TEXT NOT NULL,
  skills            TEXT DEFAULT '[]',
  mcp_servers       TEXT DEFAULT '[]',
  result            TEXT,
  structured_output TEXT,
  error             TEXT,
  cost_usd          REAL,
  num_turns         INTEGER,
  duration_ms       INTEGER,
  worker_id         TEXT,
  push_notification TEXT,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER
);

CREATE TABLE task_logs (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  content    TEXT NOT NULL,
  metadata   TEXT DEFAULT '{}',
  timestamp  INTEGER NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE INDEX idx_tasks_session ON tasks(session_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_task_logs_task ON task_logs(task_id);
```

## 4. 架构分层

```
               ┌──────────────────────────────────────────────┐
               │              Channel Layer                    │
               │                                               │
  WebSocket ──▶│  WebChat Channel  (verify → toTaskRequest)    │
  Webhook ────▶│  GitHub Channel   (verify → toTaskRequest)    │
  Webhook ────▶│  Slack Channel    (verify → toTaskRequest)    │
               └──────────┬───────────────────────────────────┘
                          │ TaskRequest (统一格式)
                          ▼
               ┌──────────────────────────────────────────────┐
               │              Task Layer                       │
               │                                               │
               │  1. 合并 channel defaults ∪ 用户指定           │
               │  2. 创建 TaskRecord (pending)                  │
               │  3. 交给 Dispatcher                            │
               └──────────┬───────────────────────────────────┘
                          │
                          ▼
               ┌──────────────────────────────────────────────┐
               │              Dispatcher                       │
               │                                               │
               │  1. Skill Resolver (解析 + git 缓存)           │
               │  2. K8sDriver / StaticDriver (获取 Worker)     │
               │  3. POST /prepare (注入 skills + MCP)          │
               │  4. POST /chat (发起任务)                      │
               │  5. SSE 流处理 (日志 + WebSocket 推送)         │
               │  6. channel.deliver() (oneshot 结果投递)       │
               │  7. pushNotification (回调通知)                │
               └──────────┬───────────────────────────────────┘
                          │
                          ▼
               ┌──────────────────────────────────────────────┐
               │              Worker (Pod)                     │
               │                                               │
               │  /prepare → 写入 skills/ + .mcp.json          │
               │  /chat    → Claude Agent SDK (ClaudeSDKClient)│
               │  /cancel  → client.interrupt()                │
               │            → SSE stream 返回                   │
               └──────────────────────────────────────────────┘
```

各层职责边界：

| 层 | 职责 | 不管的事 |
|---|------|---------|
| **Channel** | 验签、翻译格式、声明默认 skill/MCP、投递结果 | 不知道 Worker 存在 |
| **Task** | 记录生命周期、合并配置、持久化 | 不知道怎么调度 Pod |
| **Dispatcher** | 解析 skill、调度 Worker、消费 SSE 流、触发投递 | 不知道请求从哪来 |
| **Worker** | 执行 Agent、返回 SSE 流 | 不知道 Channel 和 Task |

## 5. Channel 抽象

### 5.1 接口定义

```typescript
interface Channel {
  readonly type: string;                  // "webchat" | "github" | "slack" | ...
  readonly defaults: ChannelDefaults;

  verify(req: IncomingRequest): Promise<boolean>;
  toTaskRequest(req: IncomingRequest): Promise<TaskRequest | null>;
  deliver?(task: TaskRecord): Promise<void>;
}

interface ChannelDefaults {
  skills: string[];
  mcpServers: MCPServerConfig[];
}

interface TaskRequest {
  sessionId: string;
  channelType: string;
  channelMeta: object;
  message: string;
  skills: string[];
  mcpServers: MCPServerConfig[];
  pushNotification?: PushNotificationConfig;
}
```

### 5.2 WebChat Channel

```typescript
const webChatChannel: Channel = {
  type: "webchat",
  defaults: { skills: [], mcpServers: [] },

  async verify() { return true; },   // WebSocket 已有连接态

  async toTaskRequest(req) {
    const msg = req.body;
    return {
      sessionId: msg.session_id,
      channelType: "webchat",
      channelMeta: {},
      message: msg.message,
      skills: msg.skills ?? [],
      mcpServers: msg.mcp_servers ?? [],
    };
  },
  // 无 deliver — Interactive 模式通过 WebSocket 实时推送
};
```

### 5.3 GitHub Channel

```typescript
const githubChannel: Channel = {
  type: "github",
  defaults: {
    skills: ["code-review"],
    mcpServers: [{
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@anthropic-ai/mcp-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    }],
  },

  async verify(req) {
    const signature = req.headers["x-hub-signature-256"];
    const expected = "sha256=" + hmac(WEBHOOK_SECRET, JSON.stringify(req.body));
    return timingSafeEqual(signature, expected);
  },

  async toTaskRequest(req) {
    const event = req.headers["x-github-event"];
    const payload = req.body;
    if (event === "pull_request" && payload.action === "opened") {
      return {
        sessionId: `gh-pr-${payload.pull_request.id}`,
        channelType: "github",
        channelMeta: {
          event, action: payload.action,
          repo: payload.repository.full_name,
          prNumber: payload.pull_request.number,
        },
        message: buildPrReviewPrompt(payload),
        skills: [],
        mcpServers: [],
      };
    }
    return null;
  },

  async deliver(task) {
    if (task.status === "completed" && task.result) {
      await githubApi.createPrComment(
        task.channelMeta.repo,
        task.channelMeta.prNumber,
        task.result,
      );
    }
  },
};
```

### 5.4 Webhook 路由

```typescript
// POST /api/channel/:type/webhook
router.post("/api/channel/:type/webhook", async (req, res) => {
  const channel = getChannel(req.params.type);
  if (!channel) return res.status(404).json({ error: "unknown channel" });

  if (!await channel.verify(req)) return res.status(401).end();

  const taskReq = await channel.toTaskRequest(req);
  if (!taskReq) return res.status(200).json({ skipped: true });

  // 合并 channel defaults
  taskReq.skills = [...channel.defaults.skills, ...taskReq.skills];
  taskReq.mcpServers = [...channel.defaults.mcpServers, ...taskReq.mcpServers];

  const task = db.createTask({ ...taskReq, status: "pending", createdAt: Date.now() });

  dispatcher.dispatch(task, channel);  // 异步，不阻塞

  res.status(202).json({ taskId: task.id });
});
```

## 6. Skill 解析

### 6.1 Skill 引用格式

用户指定的是一个 SkillRef 字符串：

```
"code-review"                     → builtin，从 worker 镜像预置
"github:owner/repo/skill-path"   → GitHub 仓库中的 skill
"local:my-skill"                  → 已在用户 workspace/skills/ 中
```

符合 Agent Skills 开放标准（agentskills.io），采用 SKILL.md 格式。社区主流安装方式就是 git clone + 文件复制（如 `npx skills add owner/repo`）。

### 6.2 Server 侧 Git 缓存

```
/data/skill-cache/
├── github/
│   ├── anthropics/skills/
│   │   ├── code-review/SKILL.md
│   │   └── deploy/SKILL.md
│   └── acme/custom-skills/
│       └── security-audit/SKILL.md
└── .cache-meta.json              # clone 时间、TTL
```

首次引用 GitHub skill → `git clone --depth 1` 到缓存。后续复用缓存，TTL 过期后 `git pull` 刷新。

### 6.3 Skill Resolver

```typescript
interface SkillResolver {
  resolve(refs: string[]): Promise<ResolvedSkill[]>;
}

interface ResolvedSkill {
  name: string;
  source: "builtin" | "github" | "local";
  files: Record<string, string>;   // 文件名 → 内容
}
```

Resolver 放在 **Server（Scheduler）层**，缓存可跨多个 Pod 复用。

### 6.4 注入方式：请求路径而非 Pod 生命周期

Skill 准备放在每次 `/chat` 之前的 `/prepare` 调用中，而不是 Pod 的 init container。原因：

- Pod 可能被复用（同 session 多个 task）
- 不同 task 可能需要不同的 skill 组合
- init container 只在 Pod 创建时运行一次

```
Task 进入 → Server resolve skills → POST /prepare → POST /chat
            (从缓存读取)            (写入 workspace)  (Agent 发现 skills)
```

每次 `/prepare` 清理旧 skills 目录，重新写入当前 task 需要的 skills。

## 7. Worker 设计

### 7.1 技术选型

- **语言**：Python（FastAPI）
- **Agent 引擎**：Claude Agent SDK（`claude-agent-sdk` Python 包）
- **核心类**：`ClaudeSDKClient`（非 `query()`）

选择 `ClaudeSDKClient` 而非 `query()` 的原因：

| 特性 | `query()` | `ClaudeSDKClient` |
|------|-----------|-------------------|
| 多轮对话 | 手动管 session resume | 内置，自动保持上下文 |
| 中断（cancel） | 不支持 | 支持 `interrupt()` |
| 自定义工具 | 不支持 | 支持 `@tool` 装饰器 |
| 钩子 | 不支持 | 支持 |
| 生命周期 | 自动 | 手动 connect/disconnect |

一个 Session 对应一个 `ClaudeSDKClient` 实例，一个 Task 对应一次 `client.query()` 调用。

### 7.2 Worker 核心代码

```python
# worker/anywork_worker/executor.py
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions

class SessionExecutor:
    """一个 Session 对应一个 Executor，管理 ClaudeSDKClient 生命周期"""

    def __init__(self, session_id: str, options: ClaudeAgentOptions):
        self.session_id = session_id
        self.client = ClaudeSDKClient(options=options)

    async def connect(self):
        await self.client.connect()

    async def execute_task(self, message: str) -> AsyncIterator[dict]:
        """执行一个 Task，流式返回 SSE 事件"""
        await self.client.query(message)
        async for msg in self.client.receive_response():
            yield to_sse_event(msg)

    async def cancel(self):
        await self.client.interrupt()

    async def disconnect(self):
        await self.client.disconnect()
```

```python
# worker/anywork_worker/http_app.py
app = FastAPI()
executors: dict[str, SessionExecutor] = {}

@app.post("/prepare")
async def prepare(request: PrepareRequest):
    """准备 skills + MCP 配置"""
    write_skills(request.skills)
    write_mcp_config(request.mcp_servers)
    return {"status": "ready"}

@app.post("/chat")
async def chat(request: ChatRequest):
    """执行 Task，SSE 流式返回"""
    executor = await get_or_create_executor(request.session_id)
    return StreamingResponse(
        stream_task(executor, request.message),
        media_type="text/event-stream",
    )

@app.post("/cancel")
async def cancel(request: CancelRequest):
    executor = executors.get(request.session_id)
    if executor:
        await executor.cancel()
    return {"status": "canceled"}
```

### 7.3 MCP 注入

Scheduler 根据 TaskRequest 的 mcpServers 生成配置，通过 `/prepare` 写入 workspace：

```python
# /prepare 处理中
async def write_mcp_config(mcp_servers: list[MCPServerConfig]):
    config = {"mcpServers": {s.name: s.to_dict() for s in mcp_servers}}
    Path("/workspace/.mcp.json").write_text(json.dumps(config))
```

`ClaudeSDKClient` 初始化时指定 `cwd="/workspace"`，Claude Code 自动发现 `.mcp.json`。

### 7.4 自定义进程内工具（可选扩展）

如果需要 Worker 向 Server 上报进度：

```python
from claude_agent_sdk import tool, create_sdk_mcp_server

@tool("report_progress", "Report task progress", {"percent": int, "message": str})
async def report_progress(args):
    await notify_server(task_id, args["percent"], args["message"])
    return {"content": [{"type": "text", "text": "Progress reported"}]}

anywork_server = create_sdk_mcp_server("anywork", tools=[report_progress])

options = ClaudeAgentOptions(
    mcp_servers={"anywork": anywork_server},
    ...
)
```

## 8. Dispatcher

### 8.1 完整流程

```python
async def dispatch(task: TaskRecord, channel: Channel):
    try:
        # 1. 解析 skills
        resolved_skills = await skill_resolver.resolve(task.skills)

        # 2. 获取/创建 Worker
        endpoint = await driver.get_worker_endpoint(task.session_id)
        db.update_task(task.id, status="running", worker_id=endpoint.pod_name,
                       started_at=now())

        # 3. 准备 skills + MCP
        await http_post(f"{endpoint.url}/prepare", {
            "task_id": task.id,
            "skills": resolved_skills,
            "mcp_servers": task.mcp_servers,
        })

        # 4. 发起 /chat，消费 SSE 流
        sse_stream = await http_post_stream(f"{endpoint.url}/chat", {
            "session_id": task.session_id,
            "message": task.message,
        })

        # 5. 处理流（写日志 + 可选 WebSocket 推送）
        await handle_worker_stream(task.id, sse_stream, ws=get_ws(task.session_id))

        # 6. Oneshot 结果投递
        finished = db.get_task(task.id)
        if channel.deliver and finished.status == "completed":
            await channel.deliver(finished)

        # 7. Push notification
        if finished.push_notification:
            await send_push(finished)

    except Exception as e:
        db.update_task(task.id, status="failed", error=str(e), finished_at=now())
```

### 8.2 SSE 流处理

```typescript
async function handleWorkerStream(taskId, sseStream, opts: { ws?: WebSocket }) {
  let seq = 0;
  for await (const event of parseSse(sseStream)) {
    // 1. 始终写入 task_logs
    db.insertTaskLog({ taskId, seq: seq++, type: event.type,
                       content: event.data, timestamp: Date.now() });

    // 2. Interactive 模式：同时推 WebSocket
    if (opts.ws) {
      opts.ws.send(JSON.stringify({ type: event.type, content: event.data }));
    }

    // 3. 更新 task status
    if (event.type === "done") {
      db.updateTask(taskId, { status: "completed", finishedAt: Date.now() });
    } else if (event.type === "error") {
      db.updateTask(taskId, { status: "failed", error: event.data, finishedAt: Date.now() });
    }
  }
}
```

## 9. 结果交付

三种机制并存，Channel 按需选择：

| 机制 | 适用场景 | 工作方式 |
|------|---------|---------|
| **WebSocket 实时推送** | Web Chat (interactive) | Server 消费 SSE 流，实时转发给浏览器 |
| **Push webhook** | GitHub/Slack (oneshot) | Task 完成后 Server 主动 POST 到 channel.deliver() |
| **Polling API** | 外部调用方 (兜底) | 调用方拿 taskId 轮询 GET /api/tasks/:id |

## 10. API

### 10.1 Task API

```
POST   /api/tasks                      ← 创建任务
GET    /api/tasks/:taskId              ← 查询任务状态和结果
GET    /api/tasks/:taskId/logs?after=0 ← 增量拉取执行日志
POST   /api/tasks/:taskId/cancel       ← 取消任务
```

### 10.2 Channel Webhook

```
POST   /api/channel/:type/webhook      ← 统一 webhook 入口
```

### 10.3 Session API

```
GET    /api/sessions                    ← 列出 sessions
GET    /api/sessions/:id               ← 获取 session 详情
DELETE /api/sessions/:id               ← 删除 session
```

### 10.4 Polling 日志（增量拉取）

```
GET /api/tasks/:taskId/logs?after=42&limit=100
→ {
    logs: [{ seq: 43, type: "text", content: "...", timestamp: ... }, ...],
    hasMore: false
  }
```

调用方记住上次拿到的最大 seq，下次从那开始。

### 10.5 Worker 内部 API

```
POST /prepare     ← Server → Worker，注入 skills + MCP 配置
POST /chat        ← Server → Worker，执行任务，返回 SSE 流
POST /cancel      ← Server → Worker，中断当前任务
GET  /health      ← 健康检查
```

## 11. Container Driver

### 11.1 接口

```typescript
interface ContainerDriver {
  getWorkerEndpoint(sessionId: string): Promise<WorkerEndpoint>;
  releaseWorker(sessionId: string): Promise<void>;
  isHealthy(endpoint: WorkerEndpoint): Promise<boolean>;
}

interface WorkerEndpoint {
  url: string;
  podName?: string;
}
```

路由键是 `sessionId`（不是 userId）。

### 11.2 Driver 实现

| Driver | 部署级别 | 工作方式 |
|--------|---------|---------|
| `StaticDriver` | Level 0 | 单一 Worker 进程，所有 session 共享 |
| `DockerDriver` | Level 0+ | 按 session 创建 Docker 容器 |
| `K8sDriver` | Level 1-2 | 按 session 创建 K8s Pod + ClusterIP Service |

### 11.3 K8s Driver

- 按 sessionId 路由，同 session 复用 Pod
- Pod 包含 workspace PVC 挂载
- endpoint 缓存 + idle TTL 自动回收
- RBAC：ServiceAccount 只有 pods/services/PVC 权限

## 12. 部署级别

### Level 0：Docker Compose（本地开发）

```
docker compose up --build → localhost:7000
```

- StaticDriver，单一 Worker 容器
- SQLite 数据库
- 仅 WebChat Channel
- Skill 通过 bind mount 或 `/prepare` 写入

### Level 1：本地 K8s（K3s / Kind）

```
kubectl apply -k deploy/k8s/
```

- K8sDriver，per-session Pod
- 仍用 SQLite
- 可测试 GitHub Channel webhook（ngrok 暴露）

### Level 2：Cloud K8s（GKE / EKS / AKS）

- K8sDriver，per-session Pod
- PostgreSQL（Cloud SQL / RDS）
- Ingress + TLS
- 多 Channel 并行（webchat + github + slack）
- skill-cache PVC 共享

```
兼容所有标准 K8s 发行版：
GCP GKE / AWS EKS / Azure AKS / 阿里云 ACK / 腾讯云 TKE
```

### 部署配置切换

```bash
# Level 0
CONTAINER_DRIVER=static

# Level 1-2
CONTAINER_DRIVER=k8s
K8S_NAMESPACE=anywork
K8S_WORKER_IMAGE=anywork-worker:latest
```

## 13. 设计决策记录

### 13.1 为什么不做 Artifact 分离？

调研了 Google A2A 协议的 Artifact 概念，但 Claude Agent SDK 没有原生 Artifact。SDK 的 `ResultMessage.result` 就是最终产出，`ResultMessage.structured_output` 支持 JSON schema 结构化输出。强行在 Task 层加 Artifact 抽象是过度设计。

### 13.2 为什么用 ClaudeSDKClient 而不是 query()？

Python SDK 的 `ClaudeSDKClient` 支持多轮对话（内置 session 管理）、中断（`interrupt()`）、自定义工具（`@tool`）、钩子。`query()` 每次新建 session，不支持中断和自定义工具。我们的 Session/Task 模型与 `ClaudeSDKClient` 的生命周期完美对齐。

### 13.3 为什么去掉 userId？

anywork 定位是调度执行引擎，不是用户平台。用户管理、鉴权、计费由部署者的上层产品处理。anywork 只认 sessionId 做路由和上下文分组。

### 13.4 为什么 Skill 注入放在请求路径而不是 Pod init container？

Skill 是 per-task 的，Pod 是 per-session 的，生命周期不同。init container 只在 Pod 创建时运行一次，Pod 复用时不会重跑。每次 task 前调 `/prepare` 重新写入 skills，Pod 新建或复用都能正确工作。

### 13.5 为什么借鉴 A2A 但不完全采用？

A2A 是 Agent 间通信协议，面向对等体。anywork 是 Server 调度 Worker，单方向的。借鉴了 A2A 的 `input_required`/`canceled` 状态和 push notification 机制，不采用 Agent Card、JSON-RPC、gRPC 等重量级概念。

### 13.6 Skill 解析为什么放在 Server 而不是 Worker？

Server 侧 git 缓存可跨多个 Pod 复用，避免每个 Pod 都 clone。Server 已有持久存储（/data），天然适合做缓存。

## 14. 与现有代码的差异

当前代码库（`claude/k8s-worker-skill-loading-L7zR6` 分支）包含首轮实现，以下部分需要迭代：

| 文件 | 变化 |
|------|------|
| `server/src/scheduler/drivers/interface.ts` | WorkerSpec 去掉 userId，路由键改为 sessionId |
| `server/src/scheduler/drivers/k8s.ts` | 去掉 init container，endpoint 按 sessionId 路由 |
| `server/src/ws/handler.ts` | 重构为 Channel + Dispatcher 模式 |
| `worker/anywork_adapter/skill_loader.py` | **删除** — 自定义 skill 格式废弃 |
| `worker/anywork_adapter/engine_claude.py` | **重写** — 从 CLI subprocess 改为 ClaudeSDKClient |
| `worker/anywork_adapter/http_channel.py` | **重写** — 去掉 nanobot，纯 Claude SDK |
| 新增 `server/src/channel/` | Channel 接口 + webchat/github 实现 |
| 新增 `server/src/task/` | TaskRecord CRUD + Dispatcher + stream handler |
| 新增 `server/src/skill/` | SkillResolver + git cache |
