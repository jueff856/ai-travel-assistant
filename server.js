require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// FlyAI MCP 配置
const MCP_URL = process.env.FLYAI_MCP_URL || 'https://flyai.open.fliggy.com/mcp';
// 优先用户配置的 Key，否则用体验模式内置 Key（每天100次免费）
const API_KEY = process.env.FLYAI_API_KEY || process.env.FLIGGY_API_KEY || 'sk-faRn8Kp2QzXvLm9YtA4EjHcWbS7oUdG5iF3xNqV6rZ';
const SIGN_SECRET = process.env.FLYAI_SIGN_SECRET || 'XSbdYnucPARDc9knhD8+X6hxdD1Nh6ZGI6Hadg25kBw=';

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// 请求签名
function signRequest(method, pathname, body, authorization, timestampMs) {
  const secret = SIGN_SECRET.trim();
  if (!secret) return null;

  const nonce = crypto.randomBytes(16).toString('hex');
  const authHeader = authorization
    ? (authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`)
    : '';

  const payload = [
    method,
    pathname,
    timestampMs,
    nonce,
    sha256(body),
    sha256(authHeader),
  ].join('\n');

  const signature = crypto.createHmac('sha256', secret)
    .update(payload, 'utf8').digest('base64url');

  return {
    'x-flyai-sign-ver': '7',
    'x-flyai-sign-alg': 'hmac-sha256',
    'x-flyai-ts': timestampMs,
    'x-flyai-nonce': nonce,
    'x-flyai-sign': signature,
  };
}

// 调用 FlyAI MCP API
async function callMCP(toolName, toolArgs) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs },
  });

  const url = new URL(MCP_URL);
  const pathname = url.pathname || '/';
  const authorization = API_KEY ? `Bearer ${API_KEY}` : '';
  const timestampMs = Date.now().toString();

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'x-ttid': 'ai2c(sk.clawhub)',
    'User-Agent': `flyai-cli/1.0.6 ${os.platform()}/${os.release()}`,
  };

  if (authorization) headers['Authorization'] = authorization;

  const signHeaders = signRequest('POST', pathname, body, authorization, timestampMs);
  if (signHeaders) Object.assign(headers, signHeaders);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`飞猪API返回 ${response.status}: ${responseText.slice(0, 200)}`);
  }

  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  let result;

  if (contentType.includes('text/event-stream')) {
    const lines = responseText.split('\n').filter(l => l.startsWith('data:'));
    const lastData = lines[lines.length - 1]?.replace(/^data:\s*/, '');
    result = JSON.parse(lastData);
  } else {
    result = JSON.parse(responseText);
  }

  if (result.error) {
    throw new Error(result.error.message || JSON.stringify(result.error));
  }

  const content = result.result?.content;
  if (content && Array.isArray(content)) {
    const textItem = content.find(c => c.type === 'text');
    if (textItem) {
      try { return JSON.parse(textItem.text); }
      catch { return { raw: textItem.text }; }
    }
  }

  return result.result || result;
}

// 常见城市列表
const CITIES = ['北京','上海','广州','深圳','杭州','成都','重庆','武汉','西安','南京',
  '长沙','青岛','厦门','昆明','大连','三亚','海口','苏州','无锡','宁波',
  '天津','郑州','合肥','福州','贵阳','哈尔滨','沈阳','济南','太原','兰州',
  '乌鲁木齐','拉萨','珠海','东莞','佛山','温州','常州','烟台','桂林','丽江',
  '洛阳','绍兴','嘉兴','湖州','金华','台州','徐州','南通','扬州','镇江',
  '玉林','百色','梧州','北海','钦州','防城港','贵港','河池','来宾','贺州'];

function extractCities(message) {
  const found = CITIES.filter(c => message.includes(c));
  const routeMatch = message.match(/([一-龥]{2,4})\s*(?:到|去|飞|→|->)\s*([一-龥]{2,4})/);
  if (routeMatch) {
    const o = CITIES.find(c => routeMatch[1].includes(c));
    const d = CITIES.find(c => routeMatch[2].includes(c));
    if (o && d) return { origin: o, destination: d };
    // 城市不在列表中时，直接用匹配到的文本
    if (routeMatch[1].length >= 2 && routeMatch[2].length >= 2) {
      return { origin: routeMatch[1], destination: routeMatch[2] };
    }
  }
  if (found.length >= 2) return { origin: found[0], destination: found[1] };
  if (found.length === 1) return { origin: null, destination: found[0] };
  return { origin: null, destination: null };
}

// 提取地标/景点关键词
function extractPoi(message) {
  // "西湖附近的酒店" — 城市名后面的地标
  const poiMatch = message.match(/(?:杭州|上海|北京|广州|深圳|成都|重庆|武汉|西安|南京|长沙|青岛|厦门|昆明|大连|三亚|海口|苏州|无锡|宁波|天津|郑州|合肥|福州|贵阳|哈尔滨|沈阳|济南|太原|兰州|桂林|丽江|珠海|东莞|佛山|温州|常州|烟台|洛阳|绍兴|嘉兴|湖州|金华|台州|徐州|南通|扬州|镇江|玉林)([一-龥]{2,6})(?:附近|周边|旁边)/);
  if (poiMatch) return poiMatch[1];
  // "西湖附近的酒店" — 无城市前缀
  const plainMatch = message.match(/([一-龥]{2,6})(?:附近|周边|旁边)的?(?:酒店|住宿|宾馆|民宿|客栈)/);
  if (plainMatch) return plainMatch[1];
  return null;
}

function resolveDate(message) {
  const absMatch = message.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
  if (absMatch) return absMatch[1].replace(/\//g, '-');
  const today = new Date();
  if (message.includes('后天')) today.setDate(today.getDate() + 2);
  else if (message.includes('明天')) today.setDate(today.getDate() + 1);
  else if (message.includes('今天') || message.includes('今日')) { /* today */ }
  else return null;
  return today.toISOString().slice(0, 10);
}

function parseIntent(message) {
  const hotelKw = ['酒店', '住宿', '宾馆', '民宿', '住哪', '客栈'];
  const flightKw = ['机票', '航班', '飞机', '航班号'];
  const trainKw = ['火车', '高铁', '动车', '火车票', '高铁票'];

  let intent = 'general';
  if (hotelKw.some(k => message.includes(k))) intent = 'hotel';
  else if (flightKw.some(k => message.includes(k))) intent = 'flight';
  else if (trainKw.some(k => message.includes(k))) intent = 'train';

  const { origin, destination } = extractCities(message);
  const poi = extractPoi(message);
  const date = resolveDate(message);
  return { intent, origin, destination, poi, date };
}

// 搜索函数
async function searchHotels(city, date, poi) {
  const args = { destName: city || '杭州', sort: 'price_asc', limit: 10 };
  if (date) args.checkInDate = date;
  if (poi) args.poiName = poi;
  return callMCP('search_hotels', args);
}

async function searchFlights(origin, destination, date) {
  const args = { origin: origin || '上海', destination: destination || '北京', limit: 10 };
  if (date) args.depDate = date;
  return callMCP('search_flight', args);
}

async function searchTrains(origin, destination, date) {
  const args = { origin: origin || '上海', destination: destination || '杭州', limit: 10 };
  if (date) args.depDate = date;
  return callMCP('search_domestic_train', args);
}

async function aiSearch(query) {
  return callMCP('fliggy_ai_search', { query });
}

// 格式化
function formatHotels(data, city) {
  const items = data?.data?.itemList;
  if (!items || items.length === 0) return `未找到${city || '目的地'}的酒店信息`;
  const top = items.slice(0, 5);
  const lines = top.map((h, i) =>
    `${i + 1}. ${h.name}\n   💰 ${h.price}/晚 | ⭐ ${h.star || '未评级'} | 📍 ${h.address}\n   🏷 ${h.interestsPoi || ''}\n   🔗 ${h.detailUrl}`
  ).join('\n\n');
  return `为您找到${city || '目的地'}的酒店：\n\n${lines}`;
}

function formatFlights(data, destination) {
  const items = data?.data?.itemList;
  if (!items || items.length === 0) return `未找到航班信息`;
  const top = items.slice(0, 5);
  const lines = top.map((item, i) => {
    const seg = item.journeys?.[0]?.segments?.[0];
    if (!seg) return '';
    const airline = seg.marketingTransportName || '';
    const no = seg.marketingTransportNo || '';
    const dep = seg.depDateTime || '';
    const arr = seg.arrDateTime || '';
    const depStation = seg.depStationShortName || seg.depStationName || '';
    const arrStation = seg.arrStationShortName || seg.arrStationName || '';
    const duration = seg.duration ? `${Math.floor(seg.duration / 60)}h${seg.duration % 60}m` : '';
    const seat = seg.seatClassName || '';
    const price = item.ticketPrice || '';
    const link = item.jumpUrl || '';
    const type = item.journeys?.[0]?.journeyType || '';
    return `${i + 1}. ${airline} ${no} [${type}]\n   🕐 ${dep.slice(11, 16)} ${depStation} → ${arr.slice(11, 16)} ${arrStation} | ⏱ ${duration}\n   💺 ${seat} | 💰 ¥${price}\n   🔗 ${link}`;
  }).filter(Boolean).join('\n\n');
  return `为您找到${destination || '目的地'}的航班：\n\n${lines}`;
}

function formatTrains(data, destination) {
  const items = data?.data?.itemList;
  if (!items || items.length === 0) return `未找到火车票信息`;
  const top = items.slice(0, 5);
  const lines = top.map((item, i) => {
    const seg = item.journeys?.[0]?.segments?.[0];
    if (!seg) return '';
    const no = seg.marketingTransportNo || '';
    const type = seg.marketingTransportName || '';
    const dep = seg.depDateTime || '';
    const arr = seg.arrDateTime || '';
    const depStation = seg.depStationShortName || seg.depStationName || '';
    const arrStation = seg.arrStationShortName || seg.arrStationName || '';
    const duration = seg.duration ? `${Math.floor(seg.duration / 60)}h${seg.duration % 60}m` : '';
    const seat = seg.seatClassName || '';
    const price = item.price || '';
    const link = item.jumpUrl || '';
    return `${i + 1}. ${no} (${type})\n   🕐 ${dep.slice(11, 16)} ${depStation} → ${arr.slice(11, 16)} ${arrStation} | ⏱ ${duration}\n   💺 ${seat} | 💰 ¥${price}\n   🔗 ${link}`;
  }).filter(Boolean).join('\n\n');
  return `为您找到${destination || '目的地'}的火车票：\n\n${lines}`;
}

function formatAiResult(data) {
  if (typeof data?.data === 'string') return data.data;
  if (data?.raw) return data.raw;
  return JSON.stringify(data, null, 2);
}

// 聊天接口
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.json({ reply: '请输入您的旅行需求，比如"帮我查杭州的酒店"' });
  }

  try {
    const { intent, origin, destination, poi, date } = parseIntent(message);
    let reply;

    switch (intent) {
      case 'hotel': {
        const data = await searchHotels(destination, date, poi);
        reply = formatHotels(data, destination);
        break;
      }
      case 'flight': {
        const data = await searchFlights(origin, destination, date);
        reply = formatFlights(data, destination);
        break;
      }
      case 'train': {
        const data = await searchTrains(origin, destination, date);
        reply = formatTrains(data, destination);
        break;
      }
      default: {
        const data = await aiSearch(message);
        reply = formatAiResult(data);
      }
    }

    res.json({ reply });
  } catch (err) {
    console.error('查询失败:', err.message);
    res.json({ reply: '抱歉，查询出了点问题，请稍后再试' });
  }
});

// 本地开发
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI旅行助手已启动: http://localhost:${PORT}`);
  });
}

// Vercel Serverless 导出
module.exports = app;
