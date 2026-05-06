# AI 旅行助手

一句话查酒店、机票、火车票、景点，基于飞猪开放平台 API。

## 两种使用方式

- **网页版** — 用户直接在网页输入自然语言，后端解析意图后调飞猪 API
- **Agent 版** — OpenClaw/Hermes/Claude Code 等宿主 Agent 调结构化接口 `/api/search`

## 部署

1. Fork 本仓库
2. 在 Vercel 导入项目，直接部署即可（API Key 已内置）
3. 访问你的 Vercel 域名即可使用

## API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/chat` | POST | 自然语言对话（网页版） |
| `/api/search` | POST | 结构化查询（Agent 用） |
| `/api/traces` | GET | 行为日志 |

## 技术栈

- Express.js + 原生前端
- 飞猪开放平台 MCP API
- Vercel Serverless 部署
