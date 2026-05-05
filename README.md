# AI旅行助手

一句话查询酒店、机票、火车票 — 基于飞猪开放平台

<!-- ![demo](docs/demo.gif) -->

## 在线体验

直接访问：[https://ai-travel-assistant-five.vercel.app](https://ai-travel-assistant-five.vercel.app)

<!-- ## 示例对话

| 查酒店 | 查机票 | 查火车票 |
|--------|--------|----------|
| ![hotel](docs/hotel.png) | ![flight](docs/flight.png) | ![train](docs/train.png) | -->

## 功能

- 酒店搜索 — 输入城市+地标，返回价格、星级、预订链接
- 机票比价 — 出发地→目的地，直达/中转，舱位价格
- 火车票查询 — 高铁/动车时刻表，二等座/一等座价格
- AI语义搜索 — 说人话也能搜，比如"周末带娃去哪玩"
- 支持相对日期 — "明天""后天"自动换算

## 技术栈

- **后端**：Node.js + Express（Vercel Serverless 部署）
- **前端**：原生 HTML/CSS/JS
- **数据源**：飞猪开放平台 FlyAI MCP API
- **API Key 安全**：仅存后端环境变量，不暴露给前端

## 快速开始

### 直接使用

访问 [https://ai-travel-assistant-five.vercel.app](https://ai-travel-assistant-five.vercel.app) 即可。

### 本地部署

```bash
git clone https://github.com/YOUR_USERNAME/ai-travel-assistant.git
cd ai-travel-assistant
npm install

# 配置 API Key
cp .env.example .env
# 编辑 .env 填入你的 FLYAI_API_KEY

npm start
# 打开 http://localhost:3000
```

### Vercel 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/YOUR_USERNAME/ai-travel-assistant)

部署后在 Vercel 控制台 Settings → Environment Variables 添加：
- `FLYAI_API_KEY` — 飞猪 API Key（[申请地址](https://flyai.open.fliggy.com/console)）

## Skill 安装（Hermes / OpenClaw 用户）

将 `fliggy-travel.skill.json` 导入你的 Agent 即可，Skill 指向 Vercel 后端，无需本地部署。

```bash
# OpenClaw 导入方式
opencli skill import fliggy-travel.skill.json
```

导入后用户说"查酒店""查机票"等，Agent 自动调用后端 API 返回结果。

## 项目结构

```
ai-travel-assistant/
├── server.js                 # Express 后端（意图解析 + 飞猪 MCP 调用）
├── public/
│   └── index.html            # 聊天界面
├── fliggy-travel.skill.json  # Skill 配置文件
├── vercel.json               # Vercel 部署配置
├── .env.example              # API Key 模板
├── .gitignore
└── package.json
```

## 支持平台

- [飞猪](https://www.fliggy.com/) — 酒店、机票、火车票、景点门票

## License

MIT