require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// FlyAI MCP 配置
const MCP_URL = process.env.FLYAI_MCP_URL || 'https://flyai.open.fliggy.com/mcp';
const API_KEY = process.env.FLYAI_API_KEY || process.env.FLIGGY_API_KEY || '';
const SIGN_SECRET = process.env.FLYAI_SIGN_SECRET || 'XSbdYnucPARDc9knhD8+X6hxdD1Nh6ZGI6Hadg25kBw=';

// SHA256
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// 生成 x-ff-ctx（设备指纹，gzip + AES加密）
function buildFfCtx() {
  const ctx = {
    machine: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memoryTierGB: Math.round(os.totalmem() / 1073741824),
      osType: os.type(),
      nodeVersion: process.version,
    },
    flyai: { version: '1.0.6' },
  };

  const json = JSON.stringify(ctx);
  const gzipped = zlib.gzipSync(Buffer.from(json, 'utf-8'));

  const secret = SIGN_SECRET.trim();
  if (!secret) return gzipped.toString('base64');

  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(gzipped), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 版本前缀 0x01 + iv + encrypted + authTag
  return Buffer.concat([Buffer.from([0x01]), iv, encrypted, authTag]).toString('base64');
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
    'x-ff-ctx': buildFfCtx(),
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

  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();

  let result;
  if (contentType.includes('text/event-stream')) {
    // SSE 响应：逐行读取
    const text = await response.text();
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    const lastData = lines[lines.length - 1]?.replace(/^data:\s*/, '');
    result = JSON.parse(lastData);
  } else {
    result = await response.json();
  }

  if (result.error) {
    throw new Error(result.error.message || JSON.stringify(result.error));
  }

  // MCP result 格式：{ content: [{ type: "text", text: "..." }] }
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
  '洛阳','绍兴','嘉兴','湖州','金华','台州','徐州','南通','扬州','镇江'];

function extractCities(message) {
  const found = CITIES.filter(c => message.includes(c));
  const routeMatch = message.match(/([一-龥]{2,4})\s*(?:到|去|飞|→|->)\s*([一-龥]{2,4})/);
  if (routeMatch) {
    const o = CITIES.find(c => routeMatch[1].includes(c)) || null;
    const d = CITIES.find(c => routeMatch[2].includes(c)) || null;
    if (o && d) return { origin: o, destination: d };
  }
  if (found.length >= 2) return { origin: found[0], destination: found[1] };
  if (found.length === 1) return { origin: null, destination: found[0] };
  return { origin: null, destination: null };
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
  const date = resolveDate(message);
  return { intent, origin, destination, date };
}

// 搜索函数
async function searchHotels(city, date) {
  const args = { 'dest-name': city || '杭州', sort: 'price_asc' };
  if (date) args['check-in-date'] = date;
  return callMCP('search_hotels', args);
}

async function searchFlights(origin, destination, date) {
  const args = { origin: origin || '上海', destination: destination || '北京' };
  if (date) args['dep-date'] = date;
  return callMCP('search_flight', args);
}

async function searchTrains(origin, destination, date) {
  const args = { origin: origin || '上海', destination: destination || '杭州' };
  if (date) args['dep-date'] = date;
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
    const { intent, origin, destination, date } = parseIntent(message);
    let reply;

    switch (intent) {
      case 'hotel': {
        const data = await searchHotels(destination, date);
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

// 本地开发：node server.js
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI旅行助手已启动: http://localhost:${PORT}`);
  });
}

// Vercel Serverless 导出
module.exports = app;
