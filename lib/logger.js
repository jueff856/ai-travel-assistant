const MAX_BUFFER = 100;

class TraceLogger {
  constructor() {
    this._buffer = [];
  }

  log(traceObj) {
    // 写入内存缓冲
    this._buffer.push(traceObj);
    if (this._buffer.length > MAX_BUFFER) {
      this._buffer.splice(0, this._buffer.length - MAX_BUFFER);
    }
    // 输出到 console（Vercel Logs 可查）
    try {
      console.log(`[TRACE] ${JSON.stringify(traceObj)}`);
    } catch {}
  }

  // 获取最近N条trace
  getRecent(limit = 20) {
    return this._buffer.slice(-limit).reverse();
  }

  // 按trace_id查找
  getById(traceId) {
    return this._buffer.find(t => t.trace_id === traceId) || null;
  }

  // 按session_id查找
  getBySession(sessionId, limit = 20) {
    return this._buffer
      .filter(t => t.session_id === sessionId)
      .slice(-limit)
      .reverse();
  }

  // 统计摘要
  getStats() {
    const total = this._buffer.length;
    const askedBack = this._buffer.filter(t => t.result?.asked_back).length;
    const failed = this._buffer.filter(t => t.result?.failed).length;
    const intents = {};
    for (const t of this._buffer) {
      const intent = t.result?.intent || 'unknown';
      intents[intent] = (intents[intent] || 0) + 1;
    }
    return { total, asked_back: askedBack, failed, intents };
  }
}

// 单例
module.exports = new TraceLogger();
