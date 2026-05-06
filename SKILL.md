---
name: fliggy-travel
description: 飞猪旅行搜索 — 查酒店、机票、火车票、景点，基于飞猪开放平台 API
---

# Fliggy Travel Skill

查询酒店、机票、火车票、景点门票。数据来自飞猪开放平台，实时价格和库存。

## 你是宿主 Agent，由你理解用户意图

**不要把用户原话直接丢给 API。** 你应该：
1. 理解用户需求，提取结构化参数
2. 调用对应的搜索接口
3. 用你的能力整理、比较、推荐结果

这样任何景点、任何说法都能处理，不依赖关键词匹配。

## API 端点

**Base URL:** `https://ai-travel-assistant-five.vercel.app`

### 结构化搜索（推荐）

```
POST /api/search
Content-Type: application/json
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | string | ✅ | `flight` / `train` / `hotel` / `poi` |
| origin | string | 交通必填 | 出发城市名（如"深圳"） |
| destination | string | ✅ | 目的城市名（如"北京"） |
| date | string | 否 | 出发/入住日期，YYYY-MM-DD |
| poi | string | 否 | 景点/地标关键词（如"环球影城"、"西湖"） |
| maxPrice | number | 否 | 最高价格 |
| partySize | number | 否 | 出行人数，会自动算总价 |
| hotelType | string | 否 | 酒店类型 |
| seatClass | string | 否 | 舱位/座位等级 |

**示例：**

```json
// 查机票
{ "type": "flight", "origin": "深圳", "destination": "北京", "date": "2026-07-01", "partySize": 3 }

// 查酒店
{ "type": "hotel", "destination": "北京", "poi": "环球影城", "date": "2026-07-01" }

// 查景点
{ "type": "poi", "destination": "北京", "poi": "环球影城" }

// 查火车票
{ "type": "train", "origin": "深圳", "destination": "北京", "date": "2026-07-01" }
```

**响应格式：**

```json
{
  "type": "flight",
  "success": true,
  "count": 5,
  "reply": "格式化的搜索结果文本",
  "budget": {
    "per_person": { "min": 490, "max": 542 },
    "total": { "min": 1470, "max": 1626 },
    "party_size": 3
  },
  "raw": { ... }
}
```

### 自然语言接口（网页版用）

```
POST /api/chat
Content-Type: application/json

{ "message": "深圳到北京的机票", "session_id": "optional" }
```

这个接口内部用正则解析，准确率有限。**Agent 请用 /api/search。**

## 使用流程

用户说："3个人暑假从深圳去北京环球影城，坐飞机，要多少预算"

你应该：
1. 提取：origin=深圳, destination=北京, date=2026-07-01, poi=环球影城, partySize=3
2. 并行调用：
   - `POST /api/search` type=flight, origin=深圳, destination=北京, date=2026-07-01, partySize=3
   - `POST /api/search` type=hotel, destination=北京, poi=环球影城, date=2026-07-01
   - `POST /api/search` type=poi, destination=北京, poi=环球影城
3. 整合结果，计算预算，给出推荐

## 支持的城市

北京、上海、广州、深圳、杭州、成都、重庆、武汉、南京、西安、长沙、厦门、昆明、三亚、青岛、大连、苏州、天津、哈尔滨、郑州、合肥、贵阳、南宁、石家庄、福州、宁波、济南、沈阳、长春、兰州、太原、海口、丽江、桂林、珠海、无锡、佛山、东莞、中山、惠州

地标也支持：环球影城→北京、迪士尼→上海、西湖→杭州、故宫→北京、长隆→广州 等

## 注意事项

- 日期格式 YYYY-MM-DD，不传则查近期
- 城市名用中文简称即可（"深圳"不是"深圳市"）
- partySize 传了会自动算多人总价
- 飞猪链接在 reply 里，用户可直接点击预订
