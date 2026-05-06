# 任务1：Agent 行为日志系统 (agent_behavior_log)

## 目标

把当前 query_log.json 升级为完整的 agent_behavior_log，记录用户与 Agent 互动的完整链路。

## 设计原则

1. **trace_id 串联** — 每次用户输入生成唯一 trace_id，同一追问链路共享 session_id
2. **步骤级记录** — 不是只记最终结果，而是记录每个决策节点
3. **JSON Schema 统一** — 所有日志遵循同一 schema，方便后续 analytics
4. **零侵入** — 中间件模式，不改变现有业务逻辑结构
5. **Vercel 兼容** — 无状态写入，不依赖本地文件系统（用内存缓冲+批量写或外部存储）

## Schema 设计

### 核心结构：Trace

```json
{
  "trace_id": "tr_20260506_a3f8k2",
  "session_id": "sess_abc123",
  "timestamp": "2026-05-06T14:30:00+08:00",
  "user_input": "五一去杭州的酒店",
  "steps": [
    {
      "step": 1,
      "type": "intent_parse",
      "timestamp": "2026-05-06T14:30:00.010+08:00",
      "input": { "raw": "五一去杭州的酒店" },
      "output": {
        "intent": "hotel",
        "origin": null,
        "destination": "杭州",
        "date": "2026-05-01",
        "poi": null
      },
      "duration_ms": 2
    },
    {
      "step": 2,
      "type": "askback_check",
      "timestamp": "2026-05-06T14:30:00.012+08:00",
      "input": { "intent": "hotel", "origin": null, "destination": "杭州" },
      "output": { "triggered": false, "reason": "hotel不需要出发地" },
      "duration_ms": 1
    },
    {
      "step": 3,
      "type": "provider_call",
      "timestamp": "2026-05-06T14:30:00.015+08:00",
      "input": { "provider": "search_hotels", "params": {"city":"杭州","date":"2026-05-01"} },
      "output": { "success": true, "result_count": 5, "has_link": true },
      "duration_ms": 850
    },
    {
      "step": 4,
      "type": "response_format",
      "timestamp": "2026-05-06T14:30:00.870+08:00",
      "input": { "intent": "hotel", "result_count": 5 },
      "output": { "reply_length": 320, "has_askback": false },
      "duration_ms": 3
    }
  ],
  "result": {
    "intent": "hotel",
    "providers_called": ["search_hotels"],
    "total_duration_ms": 866,
    "asked_back": false,
    "askback_field": null,
    "result_count": 5,
    "has_link": true,
    "failed": false,
    "failure_reason": null
  },
  "meta": {
    "user_agent": "Mozilla/5.0...",
    "ip": "1.2.3.4",
    "vercel_region": "hnd1"
  }
}
```

### 追问链路示例

```json
{
  "trace_id": "tr_20260506_b7g1m9",
  "session_id": "sess_abc123",
  "parent_trace_id": null,
  "timestamp": "2026-05-06T14:31:00+08:00",
  "user_input": "机票",
  "steps": [
    { "step": 1, "type": "intent_parse", "output": { "intent": "general", "origin": null, "destination": null } },
    { "step": 2, "type": "askback_check", "output": { "triggered": true, "field": "origin_and_dest", "question": "您要从哪飞到哪？" } }
  ],
  "result": {
    "asked_back": true,
    "askback_field": "origin_and_dest",
    "askback_options": ["北京→上海", "上海→北京", "广州→成都"]
  }
}
```

用户回答追问后：
```json
{
  "trace_id": "tr_20260506_c2h4n3",
  "session_id": "sess_abc123",
  "parent_trace_id": "tr_20260506_b7g1m9",
  "user_input": "上海到北京",
  "steps": [...],
  "result": { "asked_back": false, "providers_called": ["search_flight"] }
}
```

### 复合意图示例

```json
{
  "trace_id": "tr_20260506_d5j8p1",
  "steps": [
    { "step": 1, "type": "intent_parse", "output": { "intent": "general", "compound": ["transport", "hotel"] } },
    { "step": 2, "type": "compound_detect", "output": { "tasks": ["transport", "hotel"], "transport_type": "flight" } },
    { "step": 3, "type": "provider_call", "output": { "provider": "search_flight", "task": "transport" } },
    { "step": 4, "type": "provider_call", "output": { "provider": "search_hotels", "task": "hotel" } }
  ]
}
```

## 实现方案

### 文件结构

```
server.js          — 主服务（添加 trace 中间件）
lib/
  trace.js         — Trace 类：创建、记录步骤、序列化
  logger.js        — 日志写入器：内存缓冲 + 批量持久化
  schema.js        — JSON Schema 定义 + 校验
```

### Trace 类 API

```js
const trace = new Trace(userInput, sessionId, meta);
trace.addStep('intent_parse', input, output, durationMs);
trace.addStep('askback_check', input, output, durationMs);
trace.addStep('provider_call', input, output, durationMs);
trace.addStep('compound_detect', input, output, durationMs);
trace.addStep('response_format', input, output, durationMs);
trace.setResult({ intent, providers_called, asked_back, ... });
trace.fail(reason);
const json = trace.toJSON();  // 完整 trace 对象
```

### 日志写入策略

**Vercel 无状态环境**下，本地文件不可靠。两阶段方案：

1. **Phase 1（现在）**：内存缓冲 + 请求结束时写 console.log（Vercel Logs 可查）+ 响应头返回 trace_id
2. **Phase 2（后续）**：接入外部存储（Supabase/MongoDB Atlas free tier）

Phase 1 实现细节：
- 每次 /api/chat 请求创建 Trace 对象
- 在每个决策节点调用 trace.addStep()
- 请求结束时 trace.toJSON() 写入 console.log(JSON.stringify(trace))
- 响应中增加 `trace_id` 字段，前端可用于关联
- 同时写入内存数组（最多保留100条），提供 /api/traces 调试端点

### 前端改造

1. 首次访问生成 session_id（localStorage 持久化）
2. 每次请求带上 session_id
3. 追问回答时带上 parent_trace_id
4. 点击链接时发送 /api/track 事件（click）

### 调试端点

```
GET /api/traces          — 最近100条trace列表
GET /api/traces/:id      — 单条trace详情
GET /api/traces?session=xxx — 按session查询
```

## 实施步骤

1. 创建 `lib/trace.js` — Trace 类
2. 创建 `lib/logger.js` — 日志写入器
3. 改造 `server.js` — 在 /api/chat 中嵌入 trace 记录
4. 改造 `public/index.html` — session_id + parent_trace_id + click tracking
5. 添加 /api/traces 调试端点
6. 添加 /api/track 点击追踪端点
7. 测试验证完整链路
8. 部署到 Vercel

## 不做的事

- 不引入数据库（Phase 1 用内存+日志）
- 不改变现有业务逻辑
- 不做 UI dashboard（只做 API 端点）
- 不做实时流式日志
