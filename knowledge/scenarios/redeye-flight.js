module.exports = {
  rule: {
    id: 'redeye-flight',
    name: '红眼航班识别',
    category: 'flight',
    scope: { intent: ['flight'], locations: ['*'] },
    condition: { type: 'redeye', desc: '用户要求红眼航班或深夜出发' },
    action: { type: 'modify_params', params: {} },
    risk_score: 0,
    explain: '识别红眼航班需求，调整查询参数',
    priority: 3,
  },

  evaluator(ctx) {
    // 红眼航班已在 extractDepHourRange 中处理
    // 此规则用于在结果中标注红眼航班信息
    if (ctx.intent !== 'flight') return null;
    if (!ctx.depHourRange || ctx.depHourRange.start < 20) return null;

    return {
      risk_score: 0,
      explain: '用户要求红眼航班(20:00-24:00)',
      action: 'append_info',
      params: {
        text: '🌙 已筛选红眼航班（20:00后出发）',
      },
    };
  },
};