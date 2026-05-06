---
name: fliggy-travel
description: 飞猪旅行搜索 — 一句话查酒店、机票、火车票，基于飞猪开放平台 MCP API
---

# Fliggy Travel Skill

一句话查询酒店、机票、火车票。

## Capabilities

| Capability | Description | Examples |
|-----------|-------------|---------|
| search_hotels | 搜索酒店，支持城市+地标 | "杭州西湖附近的酒店", "三亚的民宿" |
| search_flights | 搜索机票，支持出发地→目的地 | "深圳飞北京", "上海到成都的机票" |
| search_trains | 搜索火车票/高铁 | "上海到杭州的高铁", "广州去长沙的火车票" |
| ai_search | AI语义搜索，理解自然语言 | "周末带娃去哪玩", "便宜又近地铁的酒店" |

## Usage

This skill calls the Fliggy Travel API endpoint:

```
POST https://ai-travel-assistant-five.vercel.app/api/chat
Content-Type: application/json

Body: { "message": "上海到北京的机票" }
Response: { "reply": "...", "trace_id": "...", "confirmed_context": { "origin": "上海", "destination": "北京", "intent": "flight" } }
```

### Context Passing

For follow-up questions, pass the `confirmed_context` from previous responses:

```json
{
  "message": "坐飞机",
  "context": { "origin": "深圳", "destination": "北京" }
}
```

### Keywords

酒店, 机票, 航班, 火车, 高铁, 动车, 住宿, 民宿, 宾馆, 火车票, 高铁票

## Examples

- "帮我查杭州的酒店"
- "上海到北京的机票"
- "杭州西湖附近的酒店"
- "明天广州去成都的航班"
- "深圳出发去北京坐飞机"
- "暑假去环球影城，三个人"