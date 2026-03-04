# AnyWork 本地 K8s 验收指南

## 环境概览

| 服务 | 地址 | 说明 |
|------|------|------|
| Web 前端 | http://localhost:7001 | 本地 Next.js dev server |
| API Server | http://localhost:3001 | K8s port-forward |
| WebSocket | ws://localhost:3001/ws | 同上 |
| Worker Pods | K8s 集群内部 | 按 session 动态创建 |

### 前置条件

- k3d 集群 `anywork` 已运行
- Server deployment 已部署且 port-forward 到 localhost:3001
- anywork-secrets 已配置 API_KEY / API_BASE_URL / MODEL

---

## 1. 启动 Web 前端

```bash
cd web && npm install
NEXT_PUBLIC_API_URL=http://localhost:3001 \
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws \
npx next dev --port 7001
```

> 端口 7001 避免 macOS AirPlay 占用 7000。

---

## 2. 更新 K8s Secrets（如需更改 LLM 配置）

```bash
kubectl -n anywork patch secret anywork-secrets -p '{"stringData":{
  "API_KEY":"<your-openrouter-key>",
  "API_BASE_URL":"https://openrouter.ai/api/v1",
  "MODEL":"anthropic/claude-sonnet-4-20250514"
}}'

# 重启 server 使新环境变量生效
kubectl -n anywork rollout restart deployment anywork-server
```

---

## 3. 重建 Worker 镜像

```bash
# 构建镜像（如有代理需要加 --build-arg）
docker build -t anywork-worker:latest ./worker

# 导入到 k3d
k3d image import anywork-worker:latest -c anywork
```

> 修改 Worker 代码后需要重复此步骤。已有的 Worker Pod 不会自动更新，需删除旧 Pod 或开新 session。

---

## 4. Webchat 测试

1. 浏览器打开 http://localhost:7001
2. 点击左侧 "New Chat" 创建新会话
3. 输入消息发送，例如 `请帮我写一个 hello world 的 Python 脚本`
4. 观察：
   - 右侧应出现 AI 回复的流式输出
   - 消息含代码块（tool_call 事件）
   - 最终显示 "done" 完成

### 预期结果

- 新 session 创建成功（侧边栏出现新会话，自动生成标题）
- Worker Pod 自动创建：`kubectl -n anywork get pods` 可见 `w-s-<sessionId>` Pod
- 消息流式返回，无报错

---

## 5. Webhook 测试

### 发送 webhook 请求

```bash
# 使用 generic webhook channel 发起任务
curl -X POST http://localhost:3001/api/channel/generic/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test-webhook-001",
    "message": "列出当前工作目录的文件"
  }'
```

返回值示例：
```json
{ "taskId": "xxx-xxx", "sessionId": "test-webhook-001" }
```

### 查询任务状态

```bash
# 替换 <taskId> 为实际返回的 taskId
curl http://localhost:3001/api/tasks/<taskId>
```

### 查询任务执行日志

```bash
curl http://localhost:3001/api/tasks/<taskId>/logs
```

### 预期结果

- 返回 202 + taskId
- 任务状态从 pending → running → completed
- logs 中包含 text / tool_call / done 事件

---

## 6. 多 Worker 并发验证

1. 在 Web 前端打开 **2 个以上** 不同的聊天会话
2. 几乎同时在每个会话中发送消息
3. 检查 Pod 列表：

```bash
kubectl -n anywork get pods -l app=anywork-worker
```

### 预期结果

- 每个 session 对应一个独立的 Worker Pod（`w-s-<sessionId>`）
- 多个 Pod 并行运行，互不干扰
- 各会话独立收到回复

---

## 7. 登录 Worker Pod 检查

### 进入 Pod

```bash
# 查看 worker pods
kubectl -n anywork get pods -l app=anywork-worker

# 进入指定 Pod
kubectl -n anywork exec -it <pod-name> -- /bin/bash
```

### 检查工作空间目录

```bash
# 在 Pod 内执行
find /workspace -type f | head -30
```

预期目录结构：

```
/workspace/
├── CLAUDE.md            # 项目指令文件
├── .mcp.json            # MCP 配置（/prepare 写入）
├── sessions/            # 对话历史
│   └── <session>.jsonl  # JSONL 格式对话记录
├── files/               # 用户文件和 Agent 输出
└── skills/              # Agent Skills
    └── <skill>/
        └── SKILL.md
```

### 查看 CLAUDE.md

```bash
cat /workspace/CLAUDE.md
```

### 查看对话记录

```bash
# 列出对话文件
ls -la /workspace/sessions/

# 查看 JSONL 对话内容（每行一个 JSON 对象）
cat /workspace/sessions/*.jsonl | python3 -m json.tool --no-ensure-ascii
```

JSONL 文件中每行是一个消息对象，包含：
- `role`: "user" / "assistant"
- `content`: 消息内容（文本或 content blocks 数组）
- `timestamp`: ISO 8601 时间戳

---

## 8. 常用排查命令

```bash
# Server 日志
kubectl -n anywork logs deployment/anywork-server -f

# Worker Pod 日志
kubectl -n anywork logs <pod-name> -f

# 查看所有 anywork 资源
kubectl -n anywork get all

# 删除 Worker Pod（强制重建）
kubectl -n anywork delete pod <pod-name>

# Server port-forward（如果断开）
kubectl -n anywork port-forward svc/anywork-server 3001:3001
```

---

## 9. 清理

```bash
# 删除所有 Worker Pods
kubectl -n anywork delete pods -l app=anywork-worker

# 完全清理
kubectl delete namespace anywork
```
