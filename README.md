# AI 旅行助手

一句话查酒店、机票、火车票、景点。

## 使用

- **网页版** — 直接输入自然语言，如"三亚亚龙湾的酒店"、"北京到上海的机票"
- **Agent 版** — 调结构化接口 `/api/search`，详见 SKILL.md

## 部署

Fork → Vercel 导入 → 完成。

## API

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/chat` | POST | 自然语言对话 |
| `/api/search` | POST | 结构化查询 |

## 技术栈

- Express.js + 原生前端
- Vercel Serverless 部署
