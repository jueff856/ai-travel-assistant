const crypto = require('crypto');

class Trace {
  constructor(userInput, sessionId = null, meta = {}) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(3).toString('hex');
    this.trace_id = `tr_${dateStr}_${rand}`;
    this.session_id = sessionId;
    this.parent_trace_id = null;
    this.timestamp = now.toISOString();
    this.user_input = userInput;
    this.steps = [];
    this.result = null;
    this.meta = meta;
    this._startMs = Date.now();
    this._stepNum = 0;
    this._providersCalled = [];
  }

  setParent(parentTraceId) {
    this.parent_trace_id = parentTraceId;
  }

  addStep(type, input, output, durationMs = null) {
    this._stepNum++;
    this.steps.push({
      step: this._stepNum,
      type,
      timestamp: new Date().toISOString(),
      input: this._sanitize(input),
      output: this._sanitize(output),
      duration_ms: durationMs !== null ? durationMs : undefined,
    });
    // 自动收集 provider 调用
    if (type === 'provider_call' && output?.provider) {
      this._providersCalled.push(output.provider);
    }
  }

  setResult(summary) {
    this.result = {
      intent: summary.intent || null,
      providers_called: this._providersCalled,
      total_duration_ms: Date.now() - this._startMs,
      asked_back: summary.asked_back || false,
      askback_field: summary.askback_field || null,
      askback_options: summary.askback_options || null,
      result_count: summary.result_count || 0,
      has_link: summary.has_link || false,
      failed: false,
      failure_reason: null,
    };
  }

  fail(reason) {
    this.result = {
      intent: null,
      providers_called: this._providersCalled,
      total_duration_ms: Date.now() - this._startMs,
      asked_back: false,
      askback_field: null,
      askback_options: null,
      result_count: 0,
      has_link: false,
      failed: true,
      failure_reason: reason,
    };
  }

  toJSON() {
    return {
      trace_id: this.trace_id,
      session_id: this.session_id,
      parent_trace_id: this.parent_trace_id,
      timestamp: this.timestamp,
      user_input: this.user_input,
      steps: this.steps,
      result: this.result,
      meta: this.meta,
    };
  }

  _sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    try {
      return JSON.parse(JSON.stringify(obj, (key, val) => {
        if (typeof val === 'string' && val.length > 500) return val.slice(0, 500) + '...[truncated]';
        return val;
      }));
    } catch {
      return { _error: 'serialization_failed' };
    }
  }
}

module.exports = Trace;
