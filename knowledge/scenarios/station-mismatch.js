module.exports = {
  rule: {
    id: 'station-mismatch',
    name: '中转站名不匹配警告',
    category: 'transfer',
    scope: { intent: ['train'], locations: ['*'] },
    condition: { type: 'station_name_mismatch', desc: '中转时到达站≠出发站，需换乘' },
    action: { type: 'append_warning', params: {} },
    risk_score: 4,
    explain: '中转站名不同，需要换乘地铁或打车',
    priority: 8,
  },

  evaluator(ctx) {
    if (!ctx.transferPlan) return null;

    const warnings = [];
    for (const plan of ctx.transferPlan.plans || []) {
      if (plan.legs?.length < 2) continue;
      const arrStation = plan.legs[0].arrStation || '';
      const depStation = plan.legs[1].depStation || '';
      // 站名不同（去掉"站"字后比较）
      const arrName = arrStation.replace(/站$/, '');
      const depName = depStation.replace(/站$/, '');
      if (arrName !== depName) {
        warnings.push(`${arrStation}→${depStation}`);
      }
    }

    if (warnings.length === 0) return null;

    return {
      risk_score: 4,
      explain: `中转站名不同: ${warnings.join('; ')}`,
      action: 'append_warning',
      params: {
        text: `⚠️ 中转站名不同（${warnings.join('、')}），需换乘地铁或打车，预留充足时间`,
      },
    };
  },
};
