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
    // raw text fallback 只在完全匹配城市名时使用
    if (CITIES.includes(routeMatch[1]) && CITIES.includes(routeMatch[2])) {
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
  if (nightMatch) return { start: 20, end: 24 };
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
  // 用中国时区计算
  const now = new Date();
  const cn = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const today = new Date(cn.getFullYear(), cn.getMonth(), cn.getDate());
  const currentYear = today.getFullYear();

  // 相对天数
  if (message.includes('大后天')) today.setDate(today.getDate() + 3);
  else if (message.includes('后天')) today.setDate(today.getDate() + 2);
  else if (message.includes('明天')) today.setDate(today.getDate() + 1);
  else if (message.includes('今天') || message.includes('今日')) { /* today */ }
  else {
    // "下下周一"等双重前缀
    const doubleWeekMatch = message.match(/下下周(日|天|一|二|三|四|五|六)/);
    // "下周一"等星期表达
    const weekMap = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
    if (doubleWeekMatch) {
      const targetDay = weekMap[doubleWeekMatch[1]];
      const currentDay = today.getDay();
      let diff = targetDay - currentDay + 14;
      if (diff < 7) diff += 7;
      today.setDate(today.getDate() + diff);
    } else {
      const weekMatch = message.match(/(这|下|本)?周(日|天|一|二|三|四|五|六)/);
      if (weekMatch) {
        const targetDay = weekMap[weekMatch[2]];
        const isNext = weekMatch[1] === '下';
        const currentDay = today.getDay();
        let diff = targetDay - currentDay;
        if (isNext) diff += 7;
        else if (diff <= 0) diff += 7;
        today.setDate(today.getDate() + diff);
      } else {
        // 节假日
        const holidays = {
          '元旦': { month: 1, day: 1 },
          '清明': { month: 4, day: 5 },
          '劳动节': { month: 5, day: 1 },
          '五一': { month: 5, day: 1 },
          '端午': { month: 5, day: 31 },
          '中秋': { month: 10, day: 6 },
          '国庆': { month: 10, day: 1 },
          '春节': { month: 1, day: 29 },
        };
        // 2026年固定日期（春节/端午/中秋每年不同，需更新）
        const holiday2026 = {
          '元旦': '2026-01-01', '春节': '2026-02-17', '清明': '2026-04-05',
          '劳动节': '2026-05-01', '五一': '2026-05-01', '端午': '2026-05-31',
          '中秋': '2026-10-06', '国庆': '2026-10-01',
        };
        let matched = false;
        for (const [name, dateStr] of Object.entries(holiday2026)) {
          if (message.includes(name)) {
            const [y, m, d] = dateStr.split('-').map(Number);
            const hDate = new Date(y, m - 1, d);
            // 如果节日已过，跳到明年（简化处理）
            if (hDate < today && name !== '元旦') continue;
            today.setTime(hDate.getTime());
            matched = true;
            break;
          }
        }
        if (!matched) {
          // "下个月X号"
          const nextMonthMatch = message.match(/下个?月(\d{1,2})[号日]/);
          if (nextMonthMatch) {
            const day = parseInt(nextMonthMatch[1]);
            let m = today.getMonth() + 2; // 下个月
            let y = today.getFullYear();
            if (m > 12) { m -= 12; y++; }
            today.setTime(new Date(y, m - 1, day).getTime());
          } else {
            return null;
          }
        }
      }
    }
  }
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIntent(message) {
  const hotelKw = ['酒店', '住宿', '宾馆', '民宿', '住哪', '客栈'];
  const flightKw = ['机票', '航班', '飞机', '航班号', '直飞', '飞'];
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

// 判断车次是否为动车/高铁
function isHighSpeed(trainNo) {
  return /^[DGCC]/.test(trainNo);
}

// 格式化火车票（动车/高铁优先排序）
function formatTrains(data, origin, destination) {
  const items = data?.data?.itemList;
  if (!items || items.length === 0) return null;
  // 排序：动车/高铁排前，普快排后
  const sorted = [...items].sort((a, b) => {
    const aNo = a.journeys?.[0]?.segments?.[0]?.marketingTransportNo || '';
    const bNo = b.journeys?.[0]?.segments?.[0]?.marketingTransportNo || '';
    const aHS = isHighSpeed(aNo) ? 0 : 1;
    const bHS = isHighSpeed(bNo) ? 0 : 1;
    return aHS - bHS;
  });
  const top = sorted.slice(0, 5);
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
    const tag = isHighSpeed(no) ? '' : ' [普快]';
    return `${i + 1}. ${no} (${type})${tag}\n   📅 ${dateStr}  🕐 ${dep.slice(11, 16)} ${depStation} → ${arr.slice(11, 16)} ${arrStation} | ⏱ ${duration}\n   💺 ${seat} | 💰 ¥${price}\n   🔗 ${link}`;
  }).filter(Boolean).join('\n\n');
  const label = origin ? `${origin}→${destination}` : destination;
  return `为您找到${label}的火车票：\n\n${lines}`;
}

// 查找中转方案（多枢纽对比，选最优）
async function searchTransferTrains(origin, destination, date) {
  const priorityHubs = ['南宁东', '广州南', '长沙南', '贵阳北', '武汉', '昆明南'];
  // 过滤掉出发/到达站本身
  const hubs = priorityHubs.filter(h => h !== origin && h !== destination);
  if (hubs.length === 0) return null;

  // 同时查前2个枢纽（并发请求）
  const hubsToTry = hubs.slice(0, 2);
  const results = await Promise.allSettled(hubsToTry.map(async (hub) => {
    const [leg1, leg2] = await Promise.all([
      searchTrains(origin, hub, date),
      searchTrains(hub, destination, date),
    ]);
    const leg1Items = leg1?.data?.itemList || [];
    const leg2Items = leg2?.data?.itemList || [];
    if (leg1Items.length === 0 || leg2Items.length === 0) return null;

    const pickBest = (items) => {
      const hs = items.filter(it => isHighSpeed(it.journeys?.[0]?.segments?.[0]?.marketingTransportNo || ''));
      const pool = hs.length > 0 ? hs : items;
      const seen = new Set();
      const unique = pool.filter(it => {
        const no = it.journeys?.[0]?.segments?.[0]?.marketingTransportNo || '';
        if (seen.has(no)) return false;
        seen.add(no);
        return true;
      });
      return unique.slice(0, 3);
    };
    const best1 = pickBest(leg1Items);
    const best2 = pickBest(leg2Items);

    // 计算该枢纽的评分：高铁数量 + 站名匹配度
    const hs1 = best1.filter(it => isHighSpeed(it.journeys?.[0]?.segments?.[0]?.marketingTransportNo || '')).length;
    const hs2 = best2.filter(it => isHighSpeed(it.journeys?.[0]?.segments?.[0]?.marketingTransportNo || '')).length;
    const leg1Arr = best1[0]?.journeys?.[0]?.segments?.[0]?.arrStationShortName || best1[0]?.journeys?.[0]?.segments?.[0]?.arrStationName || '';
    const leg2Dep = best2[0]?.journeys?.[0]?.segments?.[0]?.depStationShortName || best2[0]?.journeys?.[0]?.segments?.[0]?.depStationName || '';
    const stationMatch = (leg1Arr === leg2Dep) ? 10 : 0;
    const score = hs1 + hs2 + stationMatch;

    return { hub, best1, best2, score, leg1Arr, leg2Dep };
  }));

  // 取评分最高的有效方案
  const validResults = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (validResults.length === 0) return null;

  const formatLeg = (items, i) => {
    const seg = items[i]?.journeys?.[0]?.segments?.[0];
    if (!seg) return null;
    const no = seg.marketingTransportNo || '';
    const dep = seg.depDateTime || '';
    const arr = seg.arrDateTime || '';
    const depSt = seg.depStationShortName || seg.depStationName || '';
    const arrSt = seg.arrStationShortName || seg.arrStationName || '';
    const dur = seg.duration ? `${Math.floor(seg.duration / 60)}h${seg.duration % 60}m` : '';
    const seat = seg.seatClassName || '';
    const price = items[i].ticketPrice || items[i].price || '';
    return { text: `   ${i + 1}) ${no} ${dep.slice(11,16)} ${depSt}→${arr.slice(11,16)} ${arrSt} | ⏱${dur} | 💺${seat} | ¥${price}`, arrStation: arrSt, depStation: depSt };
  };

  const parts = [];
  for (const plan of validResults) {
    const lines1 = plan.best1.map((_, i) => formatLeg(plan.best1, i)).filter(Boolean);
    const lines2 = plan.best2.map((_, i) => formatLeg(plan.best2, i)).filter(Boolean);
    if (lines1.length === 0 || lines2.length === 0) continue;

    const warnings = [];
    if (plan.leg1Arr && plan.leg2Dep && plan.leg1Arr !== plan.leg2Dep) {
      warnings.push(`⚠️ 第一程到${plan.leg1Arr}，第二程从${plan.leg2Dep}出发，需换乘地铁/打车（约30-40分钟），请预留转车时间`);
    }
    const warnText = warnings.length > 0 ? '\n\n' + warnings.join('\n') : '';
    parts.push(`🔄 中转方案（经${plan.hub}）：\n\n第一段 ${origin}→${plan.hub}：\n${lines1.map(x=>x.text).join('\n')}\n\n第二段 ${plan.hub}→${destination}：\n${lines2.map(x=>x.text).join('\n')}${warnText}`);
  }

  if (parts.length === 0) return null;
  return parts.join('\n\n') + '\n\n💡 建议：选第一段尽早到达的车次，留出换乘时间，再接第二段出发的车次';
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

const fs = require('fs');

// 埋点日志
const LOG_FILE = path.join(__dirname, 'query_log.json');
function logQuery(entry) {
  try {
    const logs = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
    logs.push(entry);
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  } catch {}
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
        // 远期日期数据不全提示
        if (parsed.date) {
          const cn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
          const today = new Date(cn.getFullYear(), cn.getMonth(), cn.getDate());
          const depDate = new Date(parsed.date);
          const daysDiff = Math.round((depDate - today) / 86400000);
          const flightItems = data?.data?.itemList || [];
          if (daysDiff > 7 && flightItems.length <= 2) {
            reply += '\n\n⚠️ 查询日期较远，飞猪数据可能不全，建议去携程/飞猪APP确认完整航班和价格';
          }
        }
        break;
      }
      case 'train': {
        const data = await searchTrains(parsed.origin, parsed.destination, parsed.date, {
          seatClass: parsed.seatClass,
          journeyType: parsed.journeyType,
          maxPrice: parsed.maxPrice,
        });
        reply = formatTrains(data, parsed.origin, parsed.destination);
        // 判断是否需要推荐中转：直达结果为空，或没有真正到达目的地的车次
        const items = data?.data?.itemList || [];
        const hasDirectToDest = items.some(it => {
          const seg = it.journeys?.[0]?.segments?.[0];
          if (!seg) return false;
          const arrSt = (seg.arrStationShortName || seg.arrStationName || '');
          return arrSt.includes(parsed.destination || '');
        });
        if (!reply || items.length === 0 || !hasDirectToDest) {
          const transfer = await searchTransferTrains(parsed.origin, parsed.destination, parsed.date);
          if (transfer) {
            reply = reply ? `${reply}\n\n${transfer}` : transfer;
          }
        }
        if (!reply) reply = `未找到${parsed.origin || ''}→${parsed.destination || ''}的火车票信息`;
        // 远期日期数据不全提示
        if (parsed.date) {
          const cn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
          const today = new Date(cn.getFullYear(), cn.getMonth(), cn.getDate());
          const depDate = new Date(parsed.date);
          const daysDiff = Math.round((depDate - today) / 86400000);
          if (daysDiff > 7 && items.length <= 2) {
            reply += '\n\n⚠️ 查询日期较远，飞猪数据可能不全，建议去 12306 APP 确认完整车次和余票';
          } else if (items.length === 0) {
            reply += '\n\n⚠️ 该日期暂无数据，可能尚未开售或已售罄，建议去 12306 APP 确认';
          }
        }
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

    // 埋点记录
    logQuery({
      timestamp: new Date().toISOString(),
      input: message,
      intent: parsed.intent,
      origin: parsed.origin,
      destination: parsed.destination,
      date: parsed.date,
      result_count: (reply.match(/^\d+\./gm) || []).length,
      has_link: reply.includes('feizhu.com') || reply.includes('fliggy.com'),
      asked_back: false,
    });

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
