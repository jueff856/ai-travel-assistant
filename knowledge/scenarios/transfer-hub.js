const hubsData = require('../data/hubs.json');

module.exports = {
  rule: {
    id: 'transfer-hub-priority',
    name: '中转枢纽推荐',
    category: 'transfer',
    scope: { intent: ['train'], locations: ['*'] },
    condition: { type: 'no_direct_train', desc: '无直达火车或直达不到目的地时推荐中转' },
    action: { type: 'recommend_transfer', params: { max_hubs: 2 } },
    risk_score: 0,
    explain: '直达不可达，推荐中转方案',
    priority: 10,
  },

  evaluator(ctx) {
    // 只在火车票场景触发
    if (ctx.intent !== 'train') return null;
    // 有直达且到达目的地 → 不触发
    if (ctx.hasDirectToDest) return null;
    // 无结果或无直达 → 触发
    return {
      risk_score: 0,
      explain: `${ctx.origin || ''}→${ctx.destination || ''}无直达火车，推荐中转方案`,
      action: 'recommend_transfer',
      params: { hubs: hubsData.hubs.slice(0, hubsData.scoring.max_hubs_per_query) },
    };
  },

  // 中转评分函数（供 searchTransferTrains 使用）
  scoreTransferPlan(plan, destination) {
    const scoring = hubsData.scoring;
    let score = 0;
    for (const leg of plan.legs) {
      if (isHighSpeed(leg.trainNo)) score += scoring.highspeed_per_train;
    }
    // 站名匹配加分
    if (plan.transferStation && plan.transferStation.includes(destination)) {
      score += scoring.station_name_match_bonus;
    }
    return score;
  },
};

function isHighSpeed(trainNo) {
  return /^[GDC]/.test(trainNo);
}
