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
const API_KEY = process.env.FLYAI_API_KEY || process.env.FLIGGY_API_KEY || 'sk-faRn8Kp2QzXvLm9YtA4EjHcWbS7oUdG5iF3xNqV6rZ';
const SIGN_SECRET = process.env.FLYAI_SIGN_SECRET || 'XSbdYnucPARDc9knhD8+X6hxdD1Nh6ZGI6Hadg25kBw=';

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function signRequest(method, pathname, body, authorization, timestampMs) {
  const secret = SIGN_SECRET.trim();
  if (!secret) return null;
  const nonce = crypto.randomBytes(16).toString('hex');
  const authHeader = authorization
    ? (authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`)
    : '';
  const payload = [method, pathname, timestampMs, nonce, sha256(body), sha256(authHeader)].join('\n');
  const signature = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
  return {
    'x-flyai-sign-ver': '7',
    'x-flyai-sign-alg': 'hmac-sha256',
    'x-flyai-ts': timestampMs,
    'x-flyai-nonce': nonce,
    'x-flyai-sign': signature,
  };
}

async function callMCP(toolName, toolArgs) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: toolArgs } });
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

  const response = await fetch(url.toString(), { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`飞猪API返回 ${response.status}: ${responseText.slice(0, 200)}`);

  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  let result;
  if (contentType.includes('text/event-stream')) {
    const lines = responseText.split('\n').filter(l => l.startsWith('data:'));
    const lastData = lines[lines.length - 1]?.replace(/^data:\s*/, '');
    result = JSON.parse(lastData);
  } else {
    result = JSON.parse(responseText);
  }
  if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

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
  '玉林','百色','梧州','北海','钦州','防城港','贵港','河池','来宾','贺州',
  '香港','澳门','台北','高雄','东京','大阪','首尔','曼谷','新加坡','吉隆坡',
  '伦敦','巴黎','纽约','洛杉矶','悉尼','墨尔本'];

function extractCities(message) {
  const found = CITIES.filter(c => message.includes(c));
  const routeMatch = message.match(/([一-龥]{2,4})\s*(?:到|去|飞|→|->)\s*([一-龥]{2,4})/);
  if (routeMatch) {
    const o = CITIES.find(c => routeMatch[1].includes(c));
    const d = CITIES.find(c => routeMatch[2].includes(c));
    if (o && d) return { origin: o, destination: d };
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
  const cityPattern = CITIES.join('|');
  const poiMatch = message.match(new RegExp(`(?:${cityPattern})([一-龥]{2,6})(?:附近|周边|旁边|周边)`));
  if (poiMatch) return poiMatch[1];
  const plainMatch = message.match(/([一-龥]{2,6})(?:附近|周边|旁边)的?(?:酒店|住宿|宾馆|民宿|客栈)/);
  if (plainMatch) return plainMatch[1];
  return null;
}

// 提取价格限制
function extractMaxPrice(message) {
  const match = message.match(/(\d+)\s*元\s*(?:以内|以下|内|之内|不到|不超过)/)
             || message.match(/(?:不超过|最多|上限)\s*(\d+)\s*元/)
             || message.match(/(\d+)\s*块\s*(?:以内|以下|内)/);
  return match ? parseInt(match[1]) : null;
}

// 提取酒店类型
function extractHotelType(message) {
  const types = [];
  if (/民宿/.test(message)) types.push('homestay');
  if (/客栈/.test(message)) types.push('inn');
  if (/酒店/.test(message) && types.length === 0) types.push('hotel');
  return types.length > 0 ? types.join(',') : null;
}

// 提取星级
function extractStars(message) {
  const match = message.match(/([一二三四五1-5])\s*星/);
  if (!match) return null;
  const map = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5' };
  return map[match[1]] || match[1];
}

// 提取床型
function extractBedType(message) {
  const types = [];
  if (/大床|king/.test(message)) types.push('king');
  if (/双床|标间|twin/.test(message)) types.push('twin');
  if (/多人|家庭|multi/.test(message)) types.push('multi');
  return types.length > 0 ? types.join(',') : null;
}

// 提取入住天数（用于计算退房日期）
function extractNights(message) {
  const match = message.match(/住\s*(\d+)\s*晚/);
  return match ? parseInt(match[1]) : null;
}

// 提取舱位
function extractSeatClass(message) {
  if (/商务舱|商务/.test(message)) return 'business';
  if (/头等舱|头等/.test(message)) return 'first';
  if (/经济舱|经济/.test(message)) return 'economy';
  return null;
}

// 提取直达/中转偏好
function extractJourneyType(message) {
  if (/直达|直飞|直航|不经停/.test(message)) return 1;
  if (/中转|转机|经停/.test(message)) return 2;
  return null;
}

// 提取出发时间范围
function extractDepHourRange(message) {
  const earlyMatch = message.match(/早上|上午|早班/);
  const lateMatch = message.match(/下午|傍晚|晚班|晚上/);
  const nightMatch = message.match(/红眼|深夜|凌晨/);
  if (earlyMatch) return { start: 6, end: 12 };
  if (lateMatch) return { start: 12, end: 20 };
  if (nightMatch) return { start: 20, end: 6 };
  // "8点之前出发"
  const beforeMatch = message.match(/(\d+)\s*点\s*(?:之前|以前|前)\s*(?:出发|走|飞)/);
  if (beforeMatch) return { start: 0, end: parseInt(beforeMatch[1]) };
  return null;
}

// 提取排序偏好
function extractSort(message) {
  if (/价格.*低|便宜|最低价|性价比/.test(message)) return 'price_asc';
  if (/价格.*高|最贵/.test(message)) return 'price_desc';
  if (/评分|好评|评价/.test(message)) return 'rate_desc';
  if (/距离.*近|最近/.test(message)) return 'distance_asc';
  return null;
}

function extractFlightSort(message) {
  if (/价格.*低|便宜|最低价/.test(message)) return 3;
  if (/价格.*高|最贵/.test(message)) return 1;
  if (/最早|最早出发|早班/.test(message)) return 6;
  if (/最晚|晚班/.test(message)) return 7;
  if (/最快|时间短|直达优先/.test(message)) return 4;
  if (/直达优先/.test(message)) return 8;
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
  const poiKw = ['景点', '好玩', '旅游', '玩什么', '打卡', '必去', '推荐去'];

  let intent = 'general';
  if (hotelKw.some(k => message.includes(k))) intent = 'hotel';
  else if (flightKw.some(k => message.includes(k))) intent = 'flight';
  else if (trainKw.some(k => message.includes(k))) intent = 'train';
  else if (poiKw.some(k => message.includes(k))) intent = 'poi';

  const { origin, destination } = extractCities(message);
  const poi = extractPoi(message);
  const date = resolveDate(message);
  const maxPrice = extractMaxPrice(message);
  const hotelType = extractHotelType(message);
  const stars = extractStars(message);
  const bedType = extractBedType(message);
  const nights = extractNights(message);
  const seatClass = extractSeatClass(message);
  const journeyType = extractJourneyType(message);
  const depHourRange = extractDepHourRange(message);
  const sort = extractSort(message);
  const flightSort = extractFlightSort(message);

  // 计算退房日期
  let checkOutDate = null;
  if (date && nights) {
    const d = new Date(date);
    d.setDate(d.getDate() + nights);
    checkOutDate = d.toISOString().slice(0, 10);
  }

  return { intent, origin, destination, poi, date, maxPrice, hotelType, stars, bedType,
    nights, checkOutDate, seatClass, journeyType, depHourRange, sort, flightSort };
}

// 搜索函数
async function searchHotels(city, date, opts = {}) {
  const args = { destName: city || '杭州', sort: opts.sort || 'price_asc', limit: 10 };
  if (date) args.checkInDate = date;
  if (opts.checkOutDate) args.checkOutDate = opts.checkOutDate;
  if (opts.poi) args.poiName = opts.poi;
  if (opts.maxPrice) args.maxPrice = opts.maxPrice;
  if (opts.hotelType) args.hotelTypes = opts.hotelType;
  if (opts.stars) args.hotelStars = opts.stars;
  if (opts.bedType) args.hotelBedTypes = opts.bedType;
  return callMCP('search_hotels', args);
}

async function searchFlights(origin, destination, date, opts = {}) {
  const args = { origin: origin || '上海', destination: destination || '北京', limit: 10 };
  if (date) args.depDate = date;
  if (opts.seatClass) args.seatClassName = opts.seatClass;
  if (opts.journeyType) args.journeyType = opts.journeyType;
  if (opts.maxPrice) args.maxPrice = opts.maxPrice;
  if (opts.flightSort) args.sortType = opts.flightSort;
  if (opts.depHourRange) {
    args.depHourStart = opts.depHourRange.start;
    args.depHourEnd = opts.depHourRange.end;
  }
  return callMCP('search_flight', args);
}

async function searchTrains(origin, destination, date, opts = {}) {
  const args = { origin: origin || '上海', destination: destination || '杭州', limit: 10 };
  if (date) args.depDate = date;
  if (opts.seatClass) args.seatClassName = opts.seatClass;
  if (opts.journeyType) args.journeyType = opts.journeyType;
  if (opts.maxPrice) args.maxPrice = opts.maxPrice;
  return callMCP('search_domestic_train', args);
}

async function searchPoi(city, keyword) {
  const args = {};
  if (city) args.cityName = city;
  if (keyword) args.keyword = keyword;
  return callMCP('search_poi', args);
}

async function aiSearch(query) {
  return callMCP('fliggy_ai_search', { query });
}

// 格式化酒店
function formatHotels(data, city) {
  const items = data?.data?.itemList;
  if (!items || items.length === 0) return `未找到${city || '目的地'}的酒店信息`;
  const top = items.slice(0, 5);
  const lines = top.map((h, i) =>
    `${i + 1}. ${h.name}\n   💰 ${h.price}/晚 | ⭐ ${h.star || '未评级'} | 📍 ${h.address}\n   🏷 ${h.interestsPoi || ''}\n   🔗 ${h.detailUrl}`
  ).join('\n\n');
  return `为您找到${city || '目的地'}的酒店：\n\n${lines}`;
}

// 格式化机票（按日期+航班号去重）
function formatFlights(data, origin, destination) {
  const items = data?.data?.itemList;
  if (!items || items.length === 0) return `未找到航班信息`;

  // 去重：同航班号+同出发时间只保留一条
  const seen = new Set();
  const unique = items.filter(item => {
    const seg = item.journeys?.[0]?.segments?.[0];
    if (!seg) return false;
    const key = `${seg.marketingTransportNo}-${seg.depDateTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const top = unique.slice(0, 5);
  const lines = top.map((item, i) => {
    const seg = item.journeys?.[0]?.segments?.[0];
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
    const dateStr = dep.slice(0, 10);
    return `${i + 1}. ${airline} ${no} [${type}]\n   📅 ${dateStr}  🕐 ${dep.slice(11, 16)} ${depStation} → ${arr.slice(11, 16)} ${arrStation} | ⏱ ${duration}\n   💺 ${seat} | 💰 ¥${price}\n   🔗 ${link}`;
  }).filter(Boolean).join('\n\n');
  const label = origin ? `${origin}→${destination}` : destination;
  return `为您找到${label}的航班：\n\n${lines}`;
}

// 格式化火车票
function formatTrains(data, origin, destination) {
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
    const price = item.ticketPrice || item.price || '';
    const link = item.jumpUrl || '';
    const dateStr = dep.slice(0, 10);
    return `${i + 1}. ${no} (${type})\n   📅 ${dateStr}  🕐 ${dep.slice(11, 16)} ${depStation} → ${arr.slice(11, 16)} ${arrStation} | ⏱ ${duration}\n   💺 ${seat} | 💰 ¥${price}\n   🔗 ${link}`;
  }).filter(Boolean).join('\n\n');
  const label = origin ? `${origin}→${destination}` : destination;
  return `为您找到${label}的火车票：\n\n${lines}`;
}

// 格式化景点
function formatPoi(data, city) {
  const items = data?.data?.itemList;
  if (!items || items.length === 0) return `未找到${city || '目的地'}的景点信息`;
  const top = items.slice(0, 8);
  const lines = top.map((p, i) => {
    const name = p.name || p.poiName || '';
    const rating = p.score || p.rating || '';
    const price = p.price || p.ticketPrice || '';
    const link = p.detailUrl || p.jumpUrl || '';
    const addr = p.address || '';
    const parts = [name];
    if (rating) parts.push(`⭐ ${rating}`);
    if (price) parts.push(`💰 ¥${price}`);
    if (addr) parts.push(`📍 ${addr}`);
    if (link) parts.push(`🔗 ${link}`);
    return `${i + 1}. ${parts.join(' | ')}`;
  }).join('\n');
  return `为您找到${city || '目的地'}的景点：\n\n${lines}`;
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
    const parsed = parseIntent(message);
    let reply;

    switch (parsed.intent) {
      case 'hotel': {
        const data = await searchHotels(parsed.destination, parsed.date, {
          poi: parsed.poi,
          maxPrice: parsed.maxPrice,
          hotelType: parsed.hotelType,
          stars: parsed.stars,
          bedType: parsed.bedType,
          checkOutDate: parsed.checkOutDate,
          sort: parsed.sort,
        });
        reply = formatHotels(data, parsed.destination);
        break;
      }
      case 'flight': {
        const data = await searchFlights(parsed.origin, parsed.destination, parsed.date, {
          seatClass: parsed.seatClass,
          journeyType: parsed.journeyType,
          maxPrice: parsed.maxPrice,
          flightSort: parsed.flightSort,
          depHourRange: parsed.depHourRange,
        });
        reply = formatFlights(data, parsed.origin, parsed.destination);
        break;
      }
      case 'train': {
        const data = await searchTrains(parsed.origin, parsed.destination, parsed.date, {
          seatClass: parsed.seatClass,
          journeyType: parsed.journeyType,
          maxPrice: parsed.maxPrice,
        });
        reply = formatTrains(data, parsed.origin, parsed.destination);
        break;
      }
      case 'poi': {
        const data = await searchPoi(parsed.destination, parsed.poi);
        reply = formatPoi(data, parsed.destination);
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI旅行助手已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
