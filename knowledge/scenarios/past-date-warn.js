module.exports = {
  rule: {
    id: 'past-date-warn',
    name: '过期日期提示',
    category: 'date',
    scope: { intent: ['hotel', 'flight', 'train'], locations: ['*'] },
    condition: { type: 'past_date', desc: '查询日期已过，无法获取历史数据' },
    action: { type: 'append_warning', params: {} },
    risk_score: 5,
    explain: '查询日期已过，无法获取历史价格',
    priority: 6,
  },

  evaluator(ctx) {
    if (!ctx.date || !ctx.isPastDate) return null;
    if (!ctx.noResults) return null; // 有结果就不警告

    return {
      risk_score: 5,
      explain: `${ctx.date} 已是过去日期`,
      action: 'append_warning',
      params: {
        text: `⚠️ ${ctx.date} 已是过去日期，无法查询历史价格。试试"明天"或"下个月"的${ctx.intent === 'hotel' ? '酒店' : ctx.intent === 'flight' ? '机票' : '火车票'}？`,
      },
    };
  },
};
