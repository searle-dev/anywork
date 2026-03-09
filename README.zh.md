# AnyWork

[English](README.md) | 中文

开源云原生 AI Agent 调度执行引擎。从多种渠道（Web 聊天、GitHub Webhook、Slack 等）接收任务请求，调度运行 Claude Agent SDK 的隔离 Worker 容器，并将结果实时流式返回。

AnyWork **不是**用户平台——不包含用户管理、认证或计费逻辑。这些由上层产品层负责处理。

## 工作原理

```
Channel  →  Task  →  Dispatcher  →  Worker (Claude Agent SDK)
                                          |
                                     MCP / Skills
```

1. Channel（webchat、GitHub、Slack…）接收事件并创建 Task
2. Dispatcher 解析 Skills + MCP 配置，调用 Worker 的 `/prepare` 和 `/chat` 接口
3. Worker 在隔离容器中运行 Claude Agent SDK，以 SSE 流式返回事件
4. Server 通过 WebSocket 将流转发到浏览器（oneshot channel 则推送到 Webhook）

## 快速开始

### 前提条件

- Docker & Docker Compose
- Anthropic API Key（或通过 OpenRouter 等平台使用 OpenAI 兼容接口）

### 本地运行

```bash
git clone https://github.com/searle-dev/anywork.git
cd anywork

cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY（或 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL）

docker compose up --build
# 打开 http://localhost:7000
```

### 不用 Docker（开发模式）

```bash
cd worker && pip install -e . && cd ..
cd server && npm install && cd ..
cd web && npm install && cd ..

bash scripts/dev.sh
```

## 架构

```
anywork/
├── web/       # Next.js 15 + React 19 + Tailwind + Zustand  (端口 7000)
├── server/    # Express + ws + better-sqlite3 + TypeScript   (端口 3001)
├── worker/    # FastAPI + Claude Agent SDK                   (端口 8080)
├── deploy/    # K8s 清单 + 云部署配置
├── docs/      # 架构与设计文档
└── scripts/   # 开发/构建辅助脚本
```

### 关键设计决策

**Channel 抽象**：任何事件来源（webchat、GitHub、Slack）均实现同一 `Channel` 接口——`verify()`、`toTaskRequest()`，可选 `deliver()`。添加新集成只需一个文件。

**每 Session 一个 Claude Agent SDK 实例**：每个 Session 对应一个 `ClaudeSDKClient`，每个 Task 调用一次 `query()`。Worker 在 Task 间无状态，但通过对话历史在 Session 内保持连续性。

**容器调度驱动模式**：`ContainerDriver` 接口有三种实现——`static`（docker-compose）、`docker`（按 Session 创建容器）、`k8s`（按 Session 创建 Pod）。通过 `CONTAINER_DRIVER` 运行时切换。

**Skills 通过 /prepare 注入**：每次任务前，Server 解析 Agent Skills 并写入工作区，Claude Code 原生发现 `SKILL.md` 文件。

**MCP 通过 .mcp.json**：Server 为每个任务生成 `.mcp.json`，Worker 在运行 Agent 前注入工作区。

**WebSocket + SSE 桥接**：浏览器 ↔ WebSocket ↔ Server ↔ HTTP/SSE ↔ Worker。

## 配置

将 `.env.example` 复制为 `.env` 并填入配置。

### LLM 提供商

```bash
# 方式 A：Anthropic 官方
ANTHROPIC_API_KEY=sk-ant-xxxxx

# 方式 B：第三方（如 OpenRouter）
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
ANTHROPIC_AUTH_TOKEN=sk-or-xxxxx
ANTHROPIC_API_KEY=                              # 必须为空字符串
ANTHROPIC_MODEL=anthropic/claude-sonnet-4-20250514
```

所有 `ANTHROPIC_*` 和 `CLAUDE_*` 变量会自动透传到 Worker 容器。

### 主要变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | Anthropic API Key | — |
| `ANTHROPIC_MODEL` | Agent 使用的模型 | — |
| `TITLE_MODEL` | Session 标题生成模型 | 回退到 Agent 模型 |
| `CONTAINER_DRIVER` | `static` / `docker` / `k8s` | `static` |
| `K8S_NAMESPACE` | Worker Pod 所在的 K8s 命名空间 | `anywork` |
| `K8S_WORKSPACE_STORAGE` | `emptydir` 或 `pvc` | `emptydir` |
| `K8S_IDLE_TTL_SECONDS` | 空闲 Worker 的回收时间（秒） | `1800` |
| `SERVER_PORT` | API Server 端口 | `3001` |

## 部署

### Level 0 — docker-compose（本地）

默认方式，使用单个静态 Worker 容器在本地运行所有服务。

```bash
docker compose up --build
```

### Level 1 — 本地 Kubernetes（K3s / Kind）

```bash
CONTAINER_DRIVER=k8s
K8S_NAMESPACE=anywork
K8S_WORKSPACE_STORAGE=emptydir
```

参见 `deploy/` 目录中的清单文件。

### Level 2 — 云 Kubernetes（GKE / EKS / AKS）

使用 `K8S_WORKSPACE_STORAGE=pvc` 实现跨 Session 持久化工作区。生产环境清单和配置参见 `deploy/`。

## 扩展 AnyWork

### 添加新 Channel

1. 创建 `server/src/channel/mychannel.ts`，实现 `Channel` 接口
2. 实现 `verify()`（签名校验）、`toTaskRequest()`，可选 `deliver()`
3. 在 `server/src/index.ts` 中调用 `registerChannel()` 注册

### 为 Worker 添加自定义工具

```python
from claude_agent_sdk import tool, create_sdk_mcp_server

@tool("my_tool", "工具描述", {"param": str})
async def my_tool(args):
    return {"content": [{"type": "text", "text": "result"}]}

server = create_sdk_mcp_server("my-server", tools=[my_tool])
# 传入 ClaudeAgentOptions.mcp_servers
```

### 添加新容器驱动

1. 创建 `server/src/scheduler/drivers/newdriver.ts`，实现 `ContainerDriver` 接口
2. 在 `server/src/scheduler/container.ts` 中添加对应 case
3. 在 `server/src/config.ts` 中添加配置变量

## 贡献

欢迎贡献！请先开 Issue 描述你想做的改动。

## 许可证

[MIT](LICENSE)
