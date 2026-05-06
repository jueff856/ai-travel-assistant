require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const Trace = require('./lib/trace');
const traceLogger = require('./lib/logger');
const Orchestrator = require('./lib/orchestrator');
const RuleEngine = require('./knowledge/rules/index');
const transferHubRule = require('./knowledge/scenarios/transfer-hub');
const farDateWarnRule = require('./knowledge/scenarios/far-date-warn');
const pastDateWarnRule = require('./knowledge/scenarios/past-date-warn');
const redeyeFlightRule = require('./knowledge/scenarios/redeye-flight');
const stationMismatchRule = require('./knowledge/scenarios/station-mismatch');
const highspeedPriorityRule = require('./knowledge/scenarios/highspeed-priority');
const landmarksData = require('./knowledge/data/landmarks.json');
const holidaysData = require('./knowledge/data/holidays.json');
const hubsData = require('./knowledge/data/hubs.json');

// 初始化规则引擎
const ruleEngine = new RuleEngine();
ruleEngine.loadModules([
  transferHubRule, farDateWarnRule, pastDateWarnRule,
  redeyeFlightRule, stationMismatchRule, highspeedPriorityRule,
]);

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

// 地标→城市映射
const LANDMARK_CITY = landmarksData.mappings;

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
  // 地标→城市补充
  for (const [landmark, city] of Object.entries(LANDMARK_CITY)) {
    if (message.includes(landmark) && !found.includes(city)) found.push(city);
  }

  // "从X出发去Y" / "X出发去Y" / "X出发到Y" 模式
  const fromMatch = message.match(/从?\s*([一-龥]{2,4})\s*出发\s*(?:去|到|飞|往)\s*([一-龥]{2,4})/);
  if (fromMatch) {
    const o = CITIES.find(c => fromMatch[1].includes(c)) || fromMatch[1];
    const d = CITIES.find(c => fromMatch[2].includes(c)) || fromMatch[2];
    return { origin: o, destination: d };
  }

  // "X到/去/飞Y" 路线模式
  const routeMatch = message.match(/([一-龥]{2,4})\s*(?:到|去|飞|→|->)\s*([一-龥]{2,4})/);
  if (routeMatch) {
    const o = CITIES.find(c => routeMatch[1].includes(c)) || routeMatch[1];
    const d = CITIES.find(c => routeMatch[2].includes(c)) || routeMatch[2];
    return { origin: o, destination: d };
  }

  // "X出发" 标记出发地，剩余城市为目的地
  const depOnlyMatch = message.match(/([一-龥]{2,4})\s*出发/);
  if (depOnlyMatch) {
    const depCity = CITIES.find(c => depOnlyMatch[1].includes(c)) || depOnlyMatch[1];
    const others = found.filter(c => c !== depCity);
    if (others.length > 0) return { origin: depCity, destination: others[0] };
    return { origin: depCity, destination: null };
  }

  if (found.length >= 2) return { origin: found[0], destination: found[1] };
  if (found.length === 1) return { origin: null, destination: found[0] };

  // Fallback: 提取任意2-4字中文城市名（交给飞猪API判断是否支持）
  // "银川的酒店" → destination=银川
  const citySuffixMatch = message.match(/([一-龥]{2,4})(?:的|机票|航班|火车|高铁|酒店|住宿|民宿|宾馆|景点|好玩)/);
  if (citySuffixMatch) {
    return { origin: null, destination: citySuffixMatch[1] };
  }
  // "去银川" / "到银川" / "飞银川"
  const goToMatch = message.match(/(?:去|到|飞|往)\s*([一-龥]{2,4})/);
  if (goToMatch) {
    return { origin: null, destination: goToMatch[1] };
  }

  return { origin: null, destination: null };
}

// 提取地标/景点关键词
function extractPoi(message) {
  // 1. 先查 landmarks.json 映射表
  const landmarkNames = Object.keys(landmarksData.mappings);
  for (const lm of landmarkNames) {
    if (message.includes(lm)) return lm;
  }
  // 2. "城市+地标+附近/周边" 模式
  const cityPattern = CITIES.join('|');
  const poiMatch = message.match(new RegExp(`(?:${cityPattern})([一-龥]{2,8})(?:附近|周边|旁边|周边)`));
  if (poiMatch) return poiMatch[1];
  // 3. "地标+附近/周边+酒店" 模式
  const plainMatch = message.match(/([一-龥]{2,8})(?:附近|周边|旁边)的?(?:酒店|住宿|宾馆|民宿|客栈)/);
  if (plainMatch) return plainMatch[1];
  // 4. "城市+地标" 模式（不需要"附近/周边"后缀），如 "三亚亚龙湾的酒店"
  const cityPoiMatch = message.match(new RegExp(`(?:${cityPattern})([一-龥]{2,8}?)(?:的?(?:酒店|住宿|宾馆|民宿|客栈))`));
  if (cityPoiMatch && !/^的/.test(cityPoiMatch[1])) return cityPoiMatch[1];
  // 5. "地标+酒店" 直接模式，如 "亚特兰蒂斯酒店"（排除城市名）
  const directMatch = message.match(/([一-龥]{2,8}?)的?(?:酒店|住宿|宾馆|民宿|客栈)/);
  if (directMatch && !CITIES.includes(directMatch[1]) && directMatch[1].length >= 2) {
    // 检查匹配到的词是否紧跟在"查/找/看/要/订"等动词后面，如果是则跳过（那是城市名不是地标）
    const verbPrefix = message.match(/[查找看要订搜问帮](.+?)(?:的)?(?:酒店|住宿|宾馆|民宿|客栈)/);
    if (!verbPrefix || verbPrefix[1].trim() !== directMatch[1]) return directMatch[1];
  }
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
        // 节假日（从 knowledge/data/holidays.json 加载）
        const holiday2026 = {};
        for (const h of holidaysData.holidays) {
          const dateStr = h.dates['2026'];
          if (dateStr) holiday2026[h.name] = `2026-${dateStr}`;
        }
        // 兼容别名
        if (!holiday2026['劳动节'] && holiday2026['五一']) holiday2026['劳动节'] = holiday2026['五一'];
        let matched = false;
        for (const [name, dateStr] of Object.entries(holiday2026)) {
          if (message.includes(name)) {
            const [y, m, d] = dateStr.split('-').map(Number);
            const hDate = new Date(y, m - 1, d);
            // 节日已过但不超过容忍天数，仍用今年
            const daysPast = Math.round((today - hDate) / 86400000);
            if (daysPast > holidaysData.rules.past_days_tolerance) continue;
            today.setTime(hDate.getTime());
            matched = true;
            break;
          }
        }
        if (!matched) {
          // "暑假" → 7月1日
          if (/暑假/.test(message)) {
            today.setTime(new Date(today.getFullYear(), 6, 1).getTime());
          } else if (/寒假/.test(message)) {
            today.setTime(new Date(today.getFullYear(), 0, 20).getTime());
          } else {
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

  // 人数
  const partyMatch = message.match(/(\d+)\s*个?\s*人/);
  const cnNumMatch = message.match(/([一二三四五六七八九两])\s*大\s*([一二三四五六七八九两])?\s*小/);
  const cnNumMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '两': 2 };
  let partySize = partyMatch ? parseInt(partyMatch[1]) : null;
  if (!partySize && cnNumMatch) {
    const adults = cnNumMap[cnNumMatch[1]] || 0;
    const kids = cnNumMatch[2] ? (cnNumMap[cnNumMatch[2]] || 0) : 0;
    partySize = adults + kids;
  }

  // 预算意图
  const hasBudgetIntent = /预算|多少钱|花费|费用|花多少|要多少/.test(message);

  // 追问决策
  const askBack = checkAskBack(message, intent, origin, destination, date);

  return { intent, origin, destination, poi, date, maxPrice, hotelType, stars, bedType,
    nights, checkOutDate, seatClass, journeyType, depHourRange, sort, flightSort, partySize, hasBudgetIntent, askBack };
}

// 追问决策表
function checkAskBack(message, intent, origin, destination, date) {
  // 有目的地但没交通方式 → 追问怎么去
  if (destination && !origin && intent === 'general') {
    return { field: 'origin_and_transport', question: `去${destination}怎么走？`, options: ['飞过去', '坐高铁', '查酒店', '看景点'] };
  }

  // 有出发地+目的地但没交通方式 → 追问交通类型
  if (origin && destination && intent === 'general') {
    return { field: 'transport_type', question: `${origin}到${destination}怎么去？`, options: ['坐高铁', '坐飞机', '都查查'] };
  }

  // general 意图且没有明确目的地 → 走 aiSearch
  if (intent === 'general') return null;

  // 酒店不需要出发地，只需要目的地
  if (intent === 'hotel') {
    if (!destination) {
      return { field: 'destination', question: '想去哪个城市住？', options: ['杭州', '上海', '三亚', '北京'] };
    }
    return null;
  }

  // 机票/火车票/景点：需要出发地+目的地
  if (!origin && !destination) {
    return { field: 'both', question: '从哪出发？去哪？', options: ['上海→北京', '广州→成都', '北京→三亚', '杭州→厦门'] };
  }
  if (!origin) {
    const fromOptions = ['上海', '北京', '广州', '深圳'];
    return { field: 'origin', question: `从哪里出发去${destination}？`, options: fromOptions };
  }
  if (!destination) {
    return { field: 'destination', question: `从${origin}去哪？`, options: ['北京', '上海', '杭州', '成都'] };
  }

  return null;
}

// 搜索函数
async function searchHotels(city, date, opts = {}) {
  const args = { destName: city || '杭州', sort: opts.sort || 'rate_desc', limit: 10 };
  if (date) args.checkInDate = date;
  if (opts.checkOutDate) args.checkOutDate = opts.checkOutDate;
  if (opts.poi) args.poiName = opts.poi;
  if (opts.maxPrice) args.maxPrice = opts.maxPrice;
  // 多人出行时过滤掉青旅（最低价太低的基本是青旅/床位房）
  if (opts.partySize && opts.partySize > 1) args.minPrice = 100;
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
    const stationMatch = (leg1Arr === leg2Dep) ? hubsData.scoring.station_name_match_bonus : 0;
    const score = hs1 * hubsData.scoring.highspeed_per_train + hs2 * hubsData.scoring.highspeed_per_train + stationMatch;

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

// 复合意图检测：一句话含交通+酒店/景点/预算/行程规划
function detectCompoundIntent(message, parsed) {
  const hasTransport = /机票|航班|飞机|直飞|飞|火车|高铁|动车|坐飞|做飞/.test(message);
  const hasHotel = /酒店|住宿|宾馆|民宿|住哪|客栈/.test(message);
  const hasPoi = /景点|好玩|必去/.test(message);
  const hasBudget = /预算|多少钱|花费|费用|花多少|要多少/.test(message);
  // 行程规划关键词：影城/乐园/玩/旅游/规划/计划/安排
  const hasPlan = /影城|乐园|玩|旅游|规划|计划|安排|攻略/.test(message);

  const tasks = [];
  if (hasTransport) tasks.push('transport');
  if (hasHotel) tasks.push('hotel');
  if (hasPoi || hasPlan) tasks.push('poi');
  if (hasBudget) tasks.push('budget');

  // 即使没有明确关键词，如果有出发地+目的地+规划意图，自动补全
  if (parsed.origin && parsed.destination && hasPlan && !tasks.includes('transport')) {
    tasks.push('transport');
  }
  if (parsed.destination && hasPlan && !tasks.includes('poi')) {
    tasks.push('poi');
  }
  if (parsed.destination && hasPlan && !tasks.includes('hotel')) {
    tasks.push('hotel');
  }

  return tasks.length >= 2 ? tasks : null;
}

// 构建响应，自动附带 confirmed_context
function buildReply(reply, parsed, traceId, extra = {}) {
  const ctx = {};
  if (parsed.origin) ctx.origin = parsed.origin;
  if (parsed.destination) ctx.destination = parsed.destination;
  if (parsed.date) ctx.date = parsed.date;
  if (parsed.intent && parsed.intent !== 'general') ctx.intent = parsed.intent;
  return { reply, trace_id: traceId, confirmed_context: ctx, ...extra };
}

// 聊天接口
app.post('/api/chat', async (req, res) => {
  const { message, session_id, parent_trace_id, context: clientContext } = req.body;
  if (!message || !message.trim()) {
    return res.json({ reply: '请输入您的旅行需求，比如"帮我查杭州的酒店"' });
  }

  // 创建 trace
  const meta = {
    user_agent: req.headers['user-agent'] || '',
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    vercel_region: req.headers['x-vercel-id'] || '',
  };
  const trace = new Trace(message, session_id, meta);
  if (parent_trace_id) trace.setParent(parent_trace_id);

  try {
    const t0 = Date.now();
    const parsed = parseIntent(message);

    // 合并客户端上下文：之前确认的实体不丢失
    if (clientContext) {
      if (!parsed.origin && clientContext.origin) parsed.origin = clientContext.origin;
      if (!parsed.destination && clientContext.destination) parsed.destination = clientContext.destination;
      if (!parsed.date && clientContext.date) parsed.date = clientContext.date;
      if (!parsed.intent || parsed.intent === 'general') {
        if (clientContext.intent && clientContext.intent !== 'general') parsed.intent = clientContext.intent;
      }
    }

    // 合并后重新计算追问
    parsed.askBack = checkAskBack(message, parsed.intent, parsed.origin, parsed.destination, parsed.date);

    trace.addStep('intent_parse', { raw: message }, {
      intent: parsed.intent, origin: parsed.origin, destination: parsed.destination,
      date: parsed.date, poi: parsed.poi, maxPrice: parsed.maxPrice,
      merged_context: !!clientContext,
    }, Date.now() - t0);
    let reply;

    // 追问机制：仅单意图时优先反问；复合意图在拆解中处理
    if (parsed.askBack && !detectCompoundIntent(message)) {
      const ab = parsed.askBack;
      trace.addStep('askback_check', { intent: parsed.intent }, { triggered: true, field: ab.field, question: ab.question, options: ab.options });
      const options = ab.options.map(o => `[${o}]`).join('  ');
      reply = `${ab.question}\n${options}\n\n直接告诉我城市名也行 👆`;
      trace.setResult({ intent: parsed.intent, asked_back: true, askback_field: ab.field, askback_options: ab.options });
      traceLogger.log(trace.toJSON());
      return res.json(buildReply(reply, parsed, trace.trace_id, { askBack: ab }));
    }

    // 复合意图拆解：一句话含交通+酒店/景点
    const compoundTasks = detectCompoundIntent(message, parsed);
    if (compoundTasks) {
      trace.addStep('compound_detect', { raw: message }, { tasks: compoundTasks });
      const results = [];
      const dest = parsed.destination;
      const orig = parsed.origin;
      const dt = parsed.date;
      let compoundAskBack = null;

      // 提取景点关键词（landmarks + 知名景点）
      const allPoiNames = Object.keys(landmarksData.mappings).concat(['环球影城','迪士尼','故宫','长城','欢乐谷','长隆','方特','海昌','融创','宋城','海洋馆','博物馆','动物园','植物园','兵马俑','张家界','九寨沟','黄山','泰山','少林寺','布达拉宫']);
      const poiKwMatch = message.match(new RegExp(`(${allPoiNames.join('|')})`));
      const poiKeyword = parsed.poi || poiKwMatch?.[1] || null;

      for (const task of compoundTasks) {
        try {
          if (task === 'transport') {
            if (!orig) {
              compoundAskBack = { field: 'origin', question: `从哪里出发去${dest}？`, options: ['上海', '北京', '广州', '深圳'] };
              trace.addStep('askback_check', { task: 'transport' }, { triggered: true, field: 'origin', reason: 'missing_origin' });
              continue;
            }
            const isFlight = /机票|航班|飞机|直飞|飞/.test(message) && !/火车|高铁|动车/.test(message);
            const isTrain = /火车|高铁|动车/.test(message) && !/机票|航班|飞机|直飞|飞/.test(message);
            if (isFlight) {
              const t1 = Date.now();
              const data = await searchFlights(orig, dest, dt, { seatClass: parsed.seatClass, journeyType: parsed.journeyType, flightSort: parsed.flightSort, depHourRange: parsed.depHourRange });
              const items = data?.data?.itemList || [];
              trace.addStep('provider_call', { provider: 'search_flight', origin: orig, destination: dest, date: dt }, { provider: 'search_flight', success: true, result_count: items.length }, Date.now() - t1);
              results.push({ type: 'flight', label: '✈️ 机票', content: formatFlights(data, orig, dest), data });
            } else if (isTrain) {
              const t1 = Date.now();
              const data = await searchTrains(orig, dest, dt, { seatClass: parsed.seatClass, journeyType: parsed.journeyType });
              const items = data?.data?.itemList || [];
              trace.addStep('provider_call', { provider: 'search_domestic_train', origin: orig, destination: dest, date: dt }, { provider: 'search_domestic_train', success: true, result_count: items.length }, Date.now() - t1);
              let trainReply = formatTrains(data, orig, dest);
              const hasDirectToDest = items.some(it => {
                const seg = it.journeys?.[0]?.segments?.[0];
                if (!seg) return false;
                return (seg.arrStationShortName || seg.arrStationName || '').includes(dest || '');
              });
              if (!trainReply || items.length === 0 || !hasDirectToDest) {
                const transfer = await searchTransferTrains(orig, dest, dt);
                if (transfer) trainReply = trainReply ? `${trainReply}\n\n${transfer}` : transfer;
              }
              if (!trainReply) trainReply = `未找到${orig || ''}→${dest || ''}的火车票信息`;
              results.push({ type: 'train', label: '🚄 火车票', content: trainReply, data });
            } else {
              const t1 = Date.now();
              const [fData, tData] = await Promise.all([
                searchFlights(orig, dest, dt, { seatClass: parsed.seatClass, journeyType: parsed.journeyType }),
                searchTrains(orig, dest, dt, { seatClass: parsed.seatClass }),
              ]);
              const fItems = fData?.data?.itemList || [];
              const tItems = tData?.data?.itemList || [];
              trace.addStep('provider_call', { provider: 'search_flight+search_domestic_train' }, { provider: 'search_flight+search_domestic_train', success: true, result_count: fItems.length + tItems.length }, Date.now() - t1);
              results.push({ type: 'flight', label: '✈️ 机票', content: formatFlights(fData, orig, dest), data: fData });
              let trainReply = formatTrains(tData, orig, dest);
              if (!trainReply) trainReply = `未找到火车票信息`;
              results.push({ type: 'train', label: '🚄 火车票', content: trainReply, data: tData });
            }
          } else if (task === 'hotel') {
            const t1 = Date.now();
            const data = await searchHotels(dest, dt, { poi: poiKeyword || parsed.poi, maxPrice: parsed.maxPrice, hotelType: parsed.hotelType, stars: parsed.stars, bedType: parsed.bedType, checkOutDate: parsed.checkOutDate, sort: parsed.sort, partySize: parsed.partySize });
            const items = data?.data?.itemList || [];
            trace.addStep('provider_call', { provider: 'search_hotels', city: dest, date: dt }, { provider: 'search_hotels', success: true, result_count: items.length }, Date.now() - t1);
            results.push({ type: 'hotel', label: '🏨 酒店', content: formatHotels(data, dest), data });
          } else if (task === 'poi') {
            const t1 = Date.now();
            const data = await searchPoi(dest, poiKeyword);
            const items = data?.data?.itemList || [];
            trace.addStep('provider_call', { provider: 'search_poi', city: dest, keyword: poiKeyword }, { provider: 'search_poi', success: true, result_count: items.length }, Date.now() - t1);
            results.push({ type: 'poi', label: '🎯 景点/玩乐', content: formatPoi(data, dest), data });
          } else if (task === 'budget') {
            // 预算计算：基于已有结果估算
            results.push({ type: 'budget', label: '💰 预算估算', content: null }); // 占位，后面填充
          }
        } catch (err) {
          trace.addStep('provider_call', { task }, { provider: task, success: false, error: err.message });
          results.push({ type: task, label: task === 'hotel' ? '🏨 酒店' : task === 'poi' ? '🎯 景点' : '🚄 交通', content: `查询失败：${err.message}` });
        }
      }

      // 预算计算
      const budgetResult = results.find(r => r.type === 'budget');
      if (budgetResult) {
        const partySize = parsed.partySize || 1;
        const flightResult = results.find(r => r.type === 'flight');
        const hotelResult = results.find(r => r.type === 'hotel');
        const trainResult = results.find(r => r.type === 'train');

        const lines = [];
        lines.push(`👥 ${partySize}人出行`);

        // 机票预算
        if (flightResult?.data?.data?.itemList?.length > 0) {
          const prices = flightResult.data.data.itemList.map(i => i.ticketPrice || 0).filter(p => p > 0);
          if (prices.length > 0) {
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            lines.push(`✈️ 机票：¥${minP}~${maxP}/人 × ${partySize}人 = ¥${minP * partySize}~${maxP * partySize}`);
          }
        }

        // 火车票预算
        if (trainResult?.data?.data?.itemList?.length > 0) {
          const prices = trainResult.data.data.itemList.map(i => i.ticketPrice || i.price || 0).filter(p => p > 0);
          if (prices.length > 0) {
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            lines.push(`🚄 火车票：¥${minP}~${maxP}/人 × ${partySize}人 = ¥${minP * partySize}~${maxP * partySize}`);
          }
        }

        // 酒店预算（按2晚估算）
        if (hotelResult?.data?.data?.itemList?.length > 0) {
          const prices = hotelResult.data.data.itemList.map(i => i.price || 0).filter(p => p > 0);
          if (prices.length > 0) {
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            const rooms = Math.ceil(partySize / 2);
            lines.push(`🏨 酒店：¥${minP}~${maxP}/晚 × 2晚 × ${rooms}间 = ¥${minP * 2 * rooms}~${maxP * 2 * rooms}`);
          }
        }

        // 景点门票（粗估）
        const poiResult = results.find(r => r.type === 'poi');
        if (poiResult?.data?.data?.itemList?.length > 0) {
          const prices = poiResult.data.data.itemList.map(i => i.price || i.ticketPrice || 0).filter(p => p > 0);
          if (prices.length > 0) {
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            lines.push(`🎯 门票：¥${minP}~${maxP}/人 × ${partySize}人 = ¥${minP * partySize}~${maxP * partySize}`);
          }
        }

        budgetResult.content = lines.join('\n');
      }

      reply = results.filter(r => r.content).map(r => `${r.label}\n${'─'.repeat(20)}\n${r.content}`).join('\n\n');
      // 复合意图中交通缺出发地时追加追问
      if (compoundAskBack) {
        const ab = compoundAskBack;
        const options = ab.options.map(o => `[${o}]`).join('  ');
        reply += `\n\n❓ ${ab.question}\n${options}\n直接告诉我城市名也行 👆`;
      }
      const hasLink = reply.includes('feizhu.com') || reply.includes('fliggy.com');
      trace.addStep('response_format', { result_count: results.length }, { reply_length: reply.length, has_link: hasLink, has_askback: !!compoundAskBack });
      trace.setResult({ intent: 'compound:' + compoundTasks.join('+'), asked_back: !!compoundAskBack, askback_field: compoundAskBack?.field, askback_options: compoundAskBack?.options, result_count: results.length, has_link: hasLink });
      traceLogger.log(trace.toJSON());
      return res.json(buildReply(reply, parsed, trace.trace_id));
    }

    switch (parsed.intent) {
      case 'hotel': {
        const t1 = Date.now();
        const data = await searchHotels(parsed.destination, parsed.date, {
          poi: parsed.poi,
          maxPrice: parsed.maxPrice,
          hotelType: parsed.hotelType,
          stars: parsed.stars,
          bedType: parsed.bedType,
          checkOutDate: parsed.checkOutDate,
          sort: parsed.sort,
          partySize: parsed.partySize,
        });
        const items = data?.data?.itemList || [];
        trace.addStep('provider_call', { provider: 'search_hotels', city: parsed.destination, date: parsed.date }, { provider: 'search_hotels', success: true, result_count: items.length }, Date.now() - t1);
        reply = formatHotels(data, parsed.destination);
        // 规则引擎：过期日期提示
        const hotelEvals = ruleEngine.evaluate({
          intent: 'hotel', date: parsed.date,
          isPastDate: parsed.date ? new Date(parsed.date) < new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })) : false,
          noResults: reply.includes('未找到'),
        });
        reply = ruleEngine.applyActions(reply, hotelEvals);
        break;
      }
      case 'flight': {
        const t1 = Date.now();
        const data = await searchFlights(parsed.origin, parsed.destination, parsed.date, {
          seatClass: parsed.seatClass,
          journeyType: parsed.journeyType,
          maxPrice: parsed.maxPrice,
          flightSort: parsed.flightSort,
          depHourRange: parsed.depHourRange,
        });
        const items = data?.data?.itemList || [];
        trace.addStep('provider_call', { provider: 'search_flight', origin: parsed.origin, destination: parsed.destination, date: parsed.date }, { provider: 'search_flight', success: true, result_count: items.length }, Date.now() - t1);
        reply = formatFlights(data, parsed.origin, parsed.destination);
        // 规则引擎：远期日期警告 + 红眼航班标注
        const cn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const today = new Date(cn.getFullYear(), cn.getMonth(), cn.getDate());
        const daysDiff = parsed.date ? Math.round((new Date(parsed.date) - today) / 86400000) : 0;
        const flightEvals = ruleEngine.evaluate({
          intent: 'flight', date: parsed.date, daysDiff,
          resultCount: (data?.data?.itemList || []).length,
          depHourRange: parsed.depHourRange,
        });
        reply = ruleEngine.applyActions(reply, flightEvals);
        break;
      }
      case 'train': {
        const t1 = Date.now();
        const data = await searchTrains(parsed.origin, parsed.destination, parsed.date, {
          seatClass: parsed.seatClass,
          journeyType: parsed.journeyType,
          maxPrice: parsed.maxPrice,
        });
        const items = data?.data?.itemList || [];
        trace.addStep('provider_call', { provider: 'search_domestic_train', origin: parsed.origin, destination: parsed.destination, date: parsed.date }, { provider: 'search_domestic_train', success: true, result_count: items.length }, Date.now() - t1);
        reply = formatTrains(data, parsed.origin, parsed.destination);
        // 规则引擎：中转推荐 + 远期日期警告
        const hasDirectToDest = items.some(it => {
          const seg = it.journeys?.[0]?.segments?.[0];
          if (!seg) return false;
          return (seg.arrStationShortName || seg.arrStationName || '').includes(parsed.destination || '');
        });
        const trainCn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const trainToday = new Date(trainCn.getFullYear(), trainCn.getMonth(), trainCn.getDate());
        const trainDaysDiff = parsed.date ? Math.round((new Date(parsed.date) - trainToday) / 86400000) : 0;
        const trainEvals = ruleEngine.evaluate({
          intent: 'train', origin: parsed.origin, destination: parsed.destination,
          date: parsed.date, daysDiff: trainDaysDiff,
          resultCount: items.length, hasDirectToDest, trainItems: items,
        });
        const needsTransfer = trainEvals.some(e => e.action === 'recommend_transfer');
        if (needsTransfer && (!reply || items.length === 0 || !hasDirectToDest)) {
          const transfer = await searchTransferTrains(parsed.origin, parsed.destination, parsed.date);
          if (transfer) reply = reply ? `${reply}\n\n${transfer}` : transfer;
        }
        if (!reply) reply = `未找到${parsed.origin || ''}→${parsed.destination || ''}的火车票信息`;
        reply = ruleEngine.applyActions(reply, trainEvals.filter(e => e.action !== 'recommend_transfer'));
        if (items.length === 0 && parsed.date) {
          reply += '\n\n⚠️ 该日期暂无数据，可能尚未开售或已售罄，建议去 12306 APP 确认';
        }
        break;
      }
      case 'poi': {
        const t1 = Date.now();
        const data = await searchPoi(parsed.destination, parsed.poi);
        const items = data?.data?.itemList || [];
        trace.addStep('provider_call', { provider: 'search_poi', city: parsed.destination, keyword: parsed.poi }, { provider: 'search_poi', success: true, result_count: items.length }, Date.now() - t1);
        reply = formatPoi(data, parsed.destination);
        break;
      }
      default: {
        const t1 = Date.now();
        const data = await aiSearch(message);
        trace.addStep('provider_call', { provider: 'fliggy_ai_search', query: message }, { provider: 'fliggy_ai_search', success: true }, Date.now() - t1);
        reply = formatAiResult(data);
      }
    }

    // 记录 trace
    const hasLink = reply.includes('feizhu.com') || reply.includes('fliggy.com');
    const resultCount = (reply.match(/^\d+\./gm) || []).length;
    trace.addStep('response_format', { intent: parsed.intent }, { reply_length: reply.length, has_link: hasLink });
    trace.setResult({ intent: parsed.intent, result_count: resultCount, has_link: hasLink });
    traceLogger.log(trace.toJSON());

    res.json(buildReply(reply, parsed, trace.trace_id));
  } catch (err) {
    console.error('查询失败:', err.message);
    trace.addStep('error', {}, { error: err.message });
    trace.fail(err.message);
    traceLogger.log(trace.toJSON());
    res.json({ reply: '抱歉，查询出了点问题，请稍后再试', trace_id: trace.trace_id, confirmed_context: {} });
  }
});

// Trace 调试端点
app.get('/api/traces', (req, res) => {
  const { session, limit } = req.query;
  const n = Math.min(parseInt(limit) || 20, 100);
  if (session) {
    return res.json({ traces: traceLogger.getBySession(session, n), stats: traceLogger.getStats() });
  }
  res.json({ traces: traceLogger.getRecent(n), stats: traceLogger.getStats() });
});

app.get('/api/traces/:id', (req, res) => {
  const trace = traceLogger.getById(req.params.id);
  if (!trace) return res.status(404).json({ error: 'trace not found' });
  res.json(trace);
});

// 前端事件追踪（点击等）
app.post('/api/track', (req, res) => {
  const { event, trace_id, url, extra } = req.body;
  console.log(`[TRACK] ${JSON.stringify({ event, trace_id, url, extra, timestamp: new Date().toISOString() })}`);
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI旅行助手已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
