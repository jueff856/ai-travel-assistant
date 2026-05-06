/**
 * 规则 Schema 定义
 * 每条规则必须包含以下字段
 */
const RULE_SCHEMA = {
  id:          { type: 'string', required: true, desc: '唯一标识，kebab-case' },
  name:        { type: 'string', required: true, desc: '规则中文名' },
  category:    { type: 'string', required: true, desc: '分类: transfer|date|flight|train|hotel|poi|general' },
  scope:       { type: 'object', required: true, desc: '适用范围' },
  'scope.intent':      { type: 'array', desc: '适用的 intent 列表，["*"] 表示全部' },
  'scope.locations':   { type: 'array', desc: '适用的城市/路线，["*"] 表示全部' },
  condition:   { type: 'object', required: true, desc: '触发条件' },
  'condition.type':    { type: 'string', desc: '条件类型标识' },
  'condition.desc':    { type: 'string', desc: '条件描述（供 LLM reasoning 使用）' },
  action:      { type: 'object', required: true, desc: '执行动作' },
  'action.type':       { type: 'string', desc: '动作类型: append_warning|recommend_transfer|reorder|filter|suggest_alternative' },
  'action.params':     { type: 'object', desc: '动作参数' },
  risk_score:  { type: 'number', required: true, desc: '风险评分 0-10，0=无风险，10=严重问题' },
  explain:     { type: 'string', required: true, desc: '规则解释（面向用户或开发者）' },
  priority:    { type: 'number', desc: '执行优先级，数字越大越先执行，默认0' },
  enabled:     { type: 'boolean', desc: '是否启用，默认true' },
};

// 动作类型枚举
const ACTION_TYPES = {
  APPEND_WARNING:       'append_warning',       // 追加警告文本
  RECOMMEND_TRANSFER:   'recommend_transfer',   // 推荐中转方案
  REORDER:              'reorder',               // 重新排序结果
  FILTER:               'filter',                // 过滤结果
  SUGGEST_ALTERNATIVE:  'suggest_alternative',   // 建议替代方案
  APPEND_INFO:          'append_info',            // 追加信息
  MODIFY_PARAMS:        'modify_params',          // 修改查询参数
};

module.exports = { RULE_SCHEMA, ACTION_TYPES };
