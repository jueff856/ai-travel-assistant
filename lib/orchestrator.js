/**
 * Orchestrator — 复合任务编排器
 *
 * 支持：
 * - 任务依赖（DAG拓扑排序）
 * - 并行执行（同层任务Promise.all）
 * - context passing（前序output→后续input）
 * - retry + fallback
 * - timeout
 * - 结果合并
 */

class Orchestrator {
  constructor() {
    this.tasks = new Map(); // id → task definition
  }

  /**
   * 添加任务
   * @param {Object} task
   * @param {string} task.id - 唯一标识
   * @param {string} task.type - 业务类型 (flight/train/hotel/poi)
   * @param {string[]} task.deps - 依赖的task id列表
   * @param {Function} task.execute - async (ctx) => output
   * @param {Function} [task.fallback] - async (ctx) => output
   * @param {number} [task.retry=1] - 重试次数
   * @param {number} [task.timeout=30000] - 超时ms
   */
  addTask(task) {
    this.tasks.set(task.id, {
      id: task.id,
      type: task.type || task.id,
      deps: task.deps || [],
      execute: task.execute,
      fallback: task.fallback || null,
      retry: task.retry ?? 1,
      timeout: task.timeout ?? 30000,
    });
  }

  /**
   * 执行所有任务
   * @param {Object} baseCtx - 基础上下文 { origin, destination, date, ... }
   * @returns {Object} { results: [{id, type, success, output, error, duration_ms}], total_duration_ms }
   */
  async run(baseCtx) {
    const startMs = Date.now();
    const order = this._topologicalSort();
    const results = new Map(); // id → result
    const ctxPool = { ...baseCtx }; // 共享上下文，前序output注入

    // 按层级执行
    for (const layer of order) {
      // 同层任务并行
      const layerResults = await Promise.all(
        layer.map(taskId => this._executeTask(taskId, { ...ctxPool }))
      );

      // 收集结果，注入context
      for (const result of layerResults) {
        results.set(result.id, result);
        if (result.success && result.output?.meta) {
          Object.assign(ctxPool, result.output.meta);
        }
      }
    }

    return {
      results: Array.from(results.values()),
      total_duration_ms: Date.now() - startMs,
    };
  }

  /**
   * 执行单个任务（含retry + fallback + timeout）
   */
  async _executeTask(taskId, ctx) {
    const task = this.tasks.get(taskId);
    if (!task) return { id: taskId, type: 'unknown', success: false, error: 'task not found', duration_ms: 0 };

    const startMs = Date.now();
    let lastError = null;

    // Retry loop
    for (let attempt = 0; attempt <= task.retry; attempt++) {
      try {
        const output = await Promise.race([
          task.execute(ctx),
          this._createTimeout(task.timeout, taskId),
        ]);
        return {
          id: task.id,
          type: task.type,
          success: true,
          output,
          duration_ms: Date.now() - startMs,
        };
      } catch (err) {
        lastError = err;
        if (attempt < task.retry) {
          await this._delay(500 * (attempt + 1)); // 递增延迟
        }
      }
    }

    // Fallback
    if (task.fallback) {
      try {
        const output = await task.fallback({ ...ctx, _error: lastError?.message });
        return {
          id: task.id,
          type: task.type,
          success: true,
          output,
          duration_ms: Date.now() - startMs,
          used_fallback: true,
        };
      } catch (fbErr) {
        lastError = fbErr;
      }
    }

    return {
      id: task.id,
      type: task.type,
      success: false,
      error: lastError?.message || 'unknown error',
      duration_ms: Date.now() - startMs,
    };
  }

  /**
   * 拓扑排序 — 返回层级数组 [[并行任务1, 并行任务2], [依赖任务], ...]
   */
  _topologicalSort() {
    const inDegree = new Map();
    const adj = new Map(); // dep → [dependents]

    for (const [id, task] of this.tasks) {
      if (!inDegree.has(id)) inDegree.set(id, 0);
      for (const dep of task.deps) {
        inDegree.set(id, (inDegree.get(id) || 0) + 1);
        if (!adj.has(dep)) adj.set(dep, []);
        adj.get(dep).push(id);
      }
    }

    const layers = [];
    let queue = Array.from(this.tasks.keys()).filter(id => (inDegree.get(id) || 0) === 0);
    const visited = new Set();

    while (queue.length > 0) {
      layers.push([...queue]);
      const nextQueue = [];
      for (const id of queue) {
        visited.add(id);
        for (const dependent of adj.get(id) || []) {
          inDegree.set(dependent, (inDegree.get(dependent) || 1) - 1);
          if (inDegree.get(dependent) === 0 && !visited.has(dependent)) {
            nextQueue.push(dependent);
          }
        }
      }
      queue = nextQueue;
    }

    // 检测循环依赖
    if (visited.size < this.tasks.size) {
      const unvisited = Array.from(this.tasks.keys()).filter(id => !visited.has(id));
      throw new Error(`Circular dependency detected: ${unvisited.join(', ')}`);
    }

    return layers;
  }

  _createTimeout(ms, taskId) {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Task ${taskId} timed out after ${ms}ms`)), ms)
    );
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取任务图信息（调试用）
   */
  getGraph() {
    const tasks = [];
    for (const [id, task] of this.tasks) {
      tasks.push({ id, type: task.type, deps: task.deps, has_fallback: !!task.fallback });
    }
    return tasks;
  }
}

module.exports = Orchestrator;
