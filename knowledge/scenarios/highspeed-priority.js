module.exports = {
  rule: {
    id: 'highspeed-priority',
    name: '高铁优先排序',
    category: 'train',
    scope: { intent: ['train'], locations: ['*'] },
    condition: { type: 'highspeed_first', desc: '火车票结果中高铁/动车优先，普快标记' },
    action: { type: 'reorder', params: { strategy: 'highspeed_first' } },
    risk_score: 0,
    explain: '高铁/动车优先展示，普快标记[普快]',
    priority: 2,
  },

  evaluator(ctx) {
    if (ctx.intent !== 'train') return null;
    if (!ctx.trainItems || ctx.trainItems.length === 0) return null;

    // 检查是否有普快需要标记
    const hasNormal = ctx.trainItems.some(t => !/^[GDC]/.test(t.trainNo || ''));
    if (!hasNormal) return null;

    return {
      risk_score: 0,
      explain: '结果含普快列车，已按高铁优先排序',
      action: 'reorder',
      params: { strategy: 'highspeed_first' },
    };
  },
};
