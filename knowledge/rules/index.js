const { ACTION_TYPES } = require('./schema');

class RuleEngine {
  constructor() {
    this.rules = [];
    this.evaluators = new Map(); // rule_id → evaluator function
  }

  /**
   * 加载规则模块
   * @param {Array} modules - [{ rule, evaluator }]
   */
  loadModules(modules) {
    for (const mod of modules) {
      if (!mod.rule || !mod.evaluator) {
        console.warn(`[RuleEngine] Invalid module: missing rule or evaluator`);
        continue;
      }
      this.rules.push(mod.rule);
      this.evaluators.set(mod.rule.id, mod.evaluator);
    }
    // 按 priority 降序排列
    this.rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * 评估所有规则
   * @param {Object} ctx - 上下文 { intent, origin, destination, date, results, daysDiff, ... }
   * @returns {Array} 匹配的评估结果 [{ rule_id, risk_score, explain, action, params }]
   */
  evaluate(ctx) {
    const results = [];
    for (const rule of this.rules) {
      if (rule.enabled === false) continue;
      // scope 检查
      if (!this._matchScope(rule.scope, ctx)) continue;
      // 执行评估函数
      const evaluator = this.evaluators.get(rule.id);
      if (!evaluator) continue;
      try {
        const evalResult = evaluator(ctx, rule);
        if (evalResult) {
          results.push({
            rule_id: rule.id,
            rule_name: rule.name,
            category: rule.category,
            risk_score: evalResult.risk_score ?? rule.risk_score,
            explain: evalResult.explain ?? rule.explain,
            action: evalResult.action ?? rule.action.type,
            params: evalResult.params ?? rule.action.params ?? {},
          });
        }
      } catch (err) {
        console.warn(`[RuleEngine] Error evaluating rule ${rule.id}:`, err.message);
      }
    }
    return results;
  }

  /**
   * 执行动作：将评估结果应用到回复文本
   * @param {string} reply - 当前回复文本
   * @param {Array} evaluations - evaluate() 返回的结果
   * @param {Object} ctx - 上下文
   * @returns {string} 修改后的回复
   */
  applyActions(reply, evaluations, ctx) {
    let result = reply;
    for (const ev of evaluations) {
      switch (ev.action) {
        case ACTION_TYPES.APPEND_WARNING:
        case ACTION_TYPES.APPEND_INFO:
          if (ev.params.text) {
            result += `\n\n${ev.params.text}`;
          }
          break;
        case ACTION_TYPES.SUGGEST_ALTERNATIVE:
          if (ev.params.text) {
            result += `\n\n💡 ${ev.params.text}`;
          }
          break;
        case ACTION_TYPES.RECOMMEND_TRANSFER:
          // 中转推荐由调用方处理（需要异步调用API）
          break;
        case ACTION_TYPES.REORDER:
          // 排序由调用方处理
          break;
        case ACTION_TYPES.FILTER:
          // 过滤由调用方处理
          break;
      }
    }
    return result;
  }

  _matchScope(scope, ctx) {
    if (!scope) return true;
    // intent 匹配
    if (scope.intent && scope.intent[0] !== '*') {
      if (!scope.intent.includes(ctx.intent)) return false;
    }
    // location 匹配
    if (scope.locations && scope.locations[0] !== '*') {
      const relevant = [ctx.origin, ctx.destination].filter(Boolean);
      if (!relevant.some(loc => scope.locations.includes(loc))) return false;
    }
    return true;
  }

  // 获取所有已加载规则
  getRules() {
    return this.rules.map(r => ({
      id: r.id, name: r.name, category: r.category,
      risk_score: r.risk_score, priority: r.priority || 0,
      enabled: r.enabled !== false,
    }));
  }
}

module.exports = RuleEngine;
