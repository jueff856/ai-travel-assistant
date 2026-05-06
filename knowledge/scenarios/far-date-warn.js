module.exports = {
  rule: {
    id: 'far-date-warn',
    name: '远期日期数据不全警告',
    category: 'date',
    scope: { intent: ['train', 'flight'], locations: ['*'] },
    condition: { type: 'far_date', desc: '查询日期>7天且结果少，数据可能不全' },
    action: { type: 'append_warning', params: {} },
    risk_score: 3,
    explain: '查询日期较远，飞猪数据可能不全',
    priority: 5,
  },

  evaluator(ctx) {
    if (!ctx.daysDiff || ctx.daysDiff <= 7) return null;
    if (!ctx.resultCount || ctx.resultCount > 2) return null;

    const platform = ctx.intent === 'train' ? '12306 APP' : '携程/飞猪APP';
    const type = ctx.intent === 'train' ? '车次和余票' : '航班和价格';

    return {
      risk_score: 3,
      explain: `查询日期距今${ctx.daysDiff}天，数据可能不全`,
      action: 'append_warning',
      params: {
        text: `⚠️ 查询日期较远，飞猪数据可能不全，建议去 ${platform} 确认完整${type}`,
      },
    };
  },
};
