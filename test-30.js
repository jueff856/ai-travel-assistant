#!/usr/bin/env node
// 30题压力测试 - 跑线上Vercel接口
const URL = 'https://ai-travel-assistant-five.vercel.app/api/chat';

const tests = [
  // ===== L1: 基础单意图 (10题) =====
  { id: 1,  level: 'L1', query: '帮我查杭州的酒店', expect: '酒店结果含杭州' },
  { id: 2,  level: 'L1', query: '北京机票多少钱', expect: '航班结果含北京' },
  { id: 3,  level: 'L1', query: '上海到杭州的高铁', expect: '火车票结果含上海杭州' },
  { id: 4,  level: 'L1', query: '三亚有什么好玩的', expect: '景点结果含三亚' },
  { id: 5,  level: 'L1', query: '成都的民宿', expect: '酒店结果含民宿' },
  { id: 6,  level: 'L1', query: '明天广州去成都的航班', expect: '航班结果含广州成都+明天日期' },
  { id: 7,  level: 'L1', query: '玉林到北京的火车票', expect: '火车票结果或中转方案' },
  { id: 8,  level: 'L1', query: '西湖附近的酒店', expect: '酒店结果含西湖' },
  { id: 9,  level: 'L1', query: '深圳飞成都', expect: '航班结果含深圳成都' },
  { id: 10, level: 'L1', query: '厦门景点推荐', expect: '景点结果含厦门' },

  // ===== L2: 条件/追问 (8题) =====
  { id: 11, level: 'L2', query: '机票', expect: '追问从哪到哪' },
  { id: 12, level: 'L2', query: '去三亚怎么走', expect: '追问交通方式或提供选项' },
  { id: 13, level: 'L2', query: '200元以内的酒店', expect: '追问城市或返回酒店结果' },
  { id: 14, level: 'L2', query: '后天上海到北京的高铁', expect: '火车票结果含后天日期' },
  { id: 15, level: 'L2', query: '北京直飞三亚', expect: '航班结果含直飞' },
  { id: 16, level: 'L2', query: '五一去杭州的酒店', expect: '酒店结果含五一日期' },
  { id: 17, level: 'L2', query: '这周六上海到杭州的高铁', expect: '火车票结果含周六日期' },
  { id: 18, level: 'L2', query: '红眼航班 上海到北京', expect: '航班结果含晚班' },

  // ===== L3: 复合意图 (6题) =====
  { id: 19, level: 'L3', query: '帮我查北京到上海的机票和酒店', expect: '同时返回机票+酒店' },
  { id: 20, level: 'L3', query: '杭州西湖附近的酒店和景点', expect: '同时返回酒店+景点' },
  { id: 21, level: 'L3', query: '广州去成都的机票和住宿', expect: '同时返回机票+酒店' },
  { id: 22, level: 'L3', query: '上海到杭州的高铁和酒店', expect: '同时返回火车票+酒店' },
  { id: 23, level: 'L3', query: '三亚的机票和景点', expect: '同时返回机票+景点' },
  { id: 24, level: 'L3', query: '北京玩住酒店和看景点', expect: '同时返回酒店+景点' },

  // ===== L4: 边缘/特殊 (4题) =====
  { id: 25, level: 'L4', query: '下个月15号上海到广州的火车', expect: '火车票结果含下月15号日期' },
  { id: 26, level: 'L4', query: '国庆去三亚的机票', expect: '航班结果含国庆日期' },
  { id: 27, level: 'L4', query: '玉林到上海', expect: '追问交通方式或返回火车/航班' },
  { id: 28, level: 'L4', query: '便宜又近地铁的酒店', expect: 'AI搜索结果或追问城市' },

  // ===== L5: 混合/极限 (2题) =====
  { id: 29, level: 'L5', query: '春节北京到三亚机票和酒店', expect: '同时返回机票+酒店含春节日期' },
  { id: 30, level: 'L5', query: '下下周一广州到成都的高铁和住宿', expect: '同时返回火车票+酒店含下下周一日期' },
];

async function runTest(test) {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: test.query }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    const reply = data.reply || '';
    const hasAskBack = !!data.askBack;

    // 判定逻辑
    let pass = false;
    let reason = '';

    if (test.expect.includes('追问')) {
      pass = hasAskBack || /从哪|去哪|哪个城市|怎么走/.test(reply);
      reason = pass ? '追问成功' : '未触发追问';
    } else if (test.expect.includes('同时返回')) {
      const parts = test.expect.split('同时返回')[1].split('+').map(s => s.trim());
      const allFound = parts.every(p => {
        if (p.includes('机票')) return /✈️|航班|机票/.test(reply);
        if (p.includes('酒店')) return /🏨|酒店|住宿/.test(reply);
        if (p.includes('景点')) return /🎯|景点/.test(reply);
        if (p.includes('火车票')) return /🚄|火车|高铁/.test(reply);
        return false;
      });
      pass = allFound;
      reason = allFound ? `复合意图拆解成功(${parts.join('+')})` : `缺少: ${parts.filter(p => {
        if (p.includes('机票')) return !/✈️|航班|机票/.test(reply);
        if (p.includes('酒店')) return !/🏨|酒店|住宿/.test(reply);
        if (p.includes('景点')) return !/🎯|景点/.test(reply);
        if (p.includes('火车票')) return !/🚄|火车|高铁/.test(reply);
        return true;
      }).join('+')}`;
    } else {
      // 单意图结果判定
      const expectKeywords = [];
      if (test.expect.includes('酒店')) expectKeywords.push('酒店|住宿|💰.*晚');
      if (test.expect.includes('航班')) expectKeywords.push('航班|✈️|机票');
      if (test.expect.includes('火车票')) expectKeywords.push('火车|高铁|🚄|中转');
      if (test.expect.includes('景点')) expectKeywords.push('景点|🎯|⭐');
      if (test.expect.includes('杭州')) expectKeywords.push('杭州');
      if (test.expect.includes('北京')) expectKeywords.push('北京');
      if (test.expect.includes('上海')) expectKeywords.push('上海');
      if (test.expect.includes('成都')) expectKeywords.push('成都');
      if (test.expect.includes('三亚')) expectKeywords.push('三亚');
      if (test.expect.includes('深圳')) expectKeywords.push('深圳');
      if (test.expect.includes('广州')) expectKeywords.push('广州');
      if (test.expect.includes('厦门')) expectKeywords.push('厦门');
      if (test.expect.includes('西湖')) expectKeywords.push('西湖');
      if (test.expect.includes('直飞')) expectKeywords.push('直飞|直达');
      if (test.expect.includes('民宿')) expectKeywords.push('民宿');
      if (test.expect.includes('晚班')) expectKeywords.push('20|21|22|23');
      if (test.expect.includes('中转')) expectKeywords.push('中转|🔄');

      // 日期判定
      let dateOk = true;
      if (test.expect.includes('明天日期')) {
        const cn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const tmr = new Date(cn.getFullYear(), cn.getMonth(), cn.getDate() + 1);
        const dateStr = `${tmr.getFullYear()}-${String(tmr.getMonth()+1).padStart(2,'0')}-${String(tmr.getDate()).padStart(2,'0')}`;
        dateOk = reply.includes(dateStr);
      }
      if (test.expect.includes('后天日期')) {
        const cn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const d = new Date(cn.getFullYear(), cn.getMonth(), cn.getDate() + 2);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        dateOk = reply.includes(dateStr);
      }
      if (test.expect.includes('周六日期')) {
        // 这周六
        const cn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const today = new Date(cn.getFullYear(), cn.getMonth(), cn.getDate());
        const currentDay = today.getDay();
        let diff = 6 - currentDay;
        if (diff <= 0) diff += 7;
        const sat = new Date(today);
        sat.setDate(sat.getDate() + diff);
        const dateStr = `${sat.getFullYear()}-${String(sat.getMonth()+1).padStart(2,'0')}-${String(sat.getDate()).padStart(2,'0')}`;
        dateOk = reply.includes(dateStr);
      }
      if (test.expect.includes('五一日期')) {
        dateOk = reply.includes('2026-05-01') || reply.includes('05-01');
      }
      if (test.expect.includes('国庆日期')) {
        dateOk = reply.includes('2026-10-01') || reply.includes('10-01');
      }
      if (test.expect.includes('春节日期')) {
        dateOk = reply.includes('2026-02-17') || reply.includes('02-17');
      }
      if (test.expect.includes('下月15号日期')) {
        const cn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        let m = cn.getMonth() + 2;
        let y = cn.getFullYear();
        if (m > 12) { m -= 12; y++; }
        const dateStr = `${y}-${String(m).padStart(2,'0')}-15`;
        dateOk = reply.includes(dateStr);
      }
      if (test.expect.includes('下下周一日期')) {
        const cn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const today = new Date(cn.getFullYear(), cn.getMonth(), cn.getDate());
        const currentDay = today.getDay();
        let diff = 1 - currentDay + 14;
        if (diff < 7) diff += 7;
        const d = new Date(today);
        d.setDate(d.getDate() + diff);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        dateOk = reply.includes(dateStr);
      }

      const keywordPass = expectKeywords.length === 0 || expectKeywords.some(kw => new RegExp(kw).test(reply));
      pass = keywordPass && dateOk;

      if (!keywordPass) reason = `关键词未命中(需${expectKeywords.join('|')})`;
      else if (!dateOk) reason = '日期不匹配';
      else reason = '通过';
    }

    // 截断reply用于显示
    const shortReply = reply.length > 200 ? reply.slice(0, 200) + '...' : reply;
    return { ...test, pass, reason, reply: shortReply, hasAskBack };
  } catch (err) {
    return { ...test, pass: false, reason: `请求失败: ${err.message}`, reply: '', hasAskBack: false };
  }
}

async function main() {
  console.log(`\n🧪 30题压力测试 - ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  // 分批执行，每批5个，避免触发限流
  const batchSize = 5;
  const results = [];

  for (let i = 0; i < tests.length; i += batchSize) {
    const batch = tests.slice(i, i + batchSize);
    console.log(`\n📦 批次 ${Math.floor(i/batchSize)+1}/${Math.ceil(tests.length/batchSize)}: 题${batch[0].id}-${batch[batch.length-1].id}`);
    const batchResults = await Promise.all(batch.map(t => runTest(t)));
    results.push(...batchResults);

    // 批次间等待2秒
    if (i + batchSize < tests.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // 输出结果
  console.log('\n' + '='.repeat(60));
  console.log('📊 测试结果\n');

  let passCount = 0;
  const levelStats = {};

  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} #${r.id} [${r.level}] "${r.query}" → ${r.reason}`);
    if (r.pass) passCount++;
    if (!levelStats[r.level]) levelStats[r.level] = { pass: 0, total: 0 };
    levelStats[r.level].total++;
    if (r.pass) levelStats[r.level].pass++;
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`📈 总通过率: ${passCount}/${tests.length} (${(passCount/tests.length*100).toFixed(1)}%)\n`);

  for (const [level, stats] of Object.entries(levelStats)) {
    console.log(`  ${level}: ${stats.pass}/${stats.total} (${(stats.pass/stats.total*100).toFixed(1)}%)`);
  }

  // 输出失败详情
  const failures = results.filter(r => !r.pass);
  if (failures.length > 0) {
    console.log('\n❌ 失败详情:\n');
    for (const f of failures) {
      console.log(`#${f.id} "${f.query}"`);
      console.log(`  原因: ${f.reason}`);
      console.log(`  回复: ${f.reply}\n`);
    }
  }
}

main().catch(console.error);
