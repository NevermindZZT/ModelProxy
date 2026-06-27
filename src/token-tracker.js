/**
 * TokenTracker — Token 用量追踪器
 *
 * 职责：
 * 1. 记录每次 LLM 请求的 token 用量（从上游 API 响应的 usage 字段提取）
 * 2. 持久化到 token-usage.jsonl（追加写 JSONL 格式）
 * 3. 提供按日/周/月/全部的聚合统计查询
 *
 * 存储格式（JSONL，每行一个 JSON 对象）：
 *   { date, model, targetModel, promptTokens, completionTokens, totalTokens, host, timestamp }
 */

const fs = require('fs');
const path = require('path');

class TokenTracker {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.logPath = path.join(dataDir, 'token-usage.jsonl');
    /** @type {Array<object>} 最近记录（内存中保留最近 500 条用于明细展示） */
    this.recentRecords = [];
    /** @type {boolean} 是否正在写入（防并发） */
    this._writing = false;
    /** @type {Array<{date:string, promptTokens:number, completionTokens:number, totalTokens:number, requests:number, models:object}>} */
    this._dailyCache = [];

    this._ensureFile();
    this._rebuildCache();
  }

  /**
   * 确保日志文件存在
   */
  _ensureFile() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      if (!fs.existsSync(this.logPath)) {
        fs.writeFileSync(this.logPath, '', 'utf-8');
      }
    } catch (e) {
      console.error('[TokenTracker] 无法创建日志文件:', e.message);
    }
  }

  /**
   * 从已有 JSONL 重建内存缓存（启动时调用）
   */
  _rebuildCache() {
    try {
      const content = fs.readFileSync(this.logPath, 'utf-8');
      if (!content.trim()) return;

      const lines = content.split('\n').filter(Boolean);
      const dailyMap = {};

      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          this._addToRecent(record);

          // 按日聚合
          const day = record.date;
          if (!dailyMap[day]) {
            dailyMap[day] = { date: day, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, requests: 0, models: {} };
          }
          dailyMap[day].promptTokens += record.promptTokens || 0;
          dailyMap[day].completionTokens += record.completionTokens || 0;
          dailyMap[day].totalTokens += record.totalTokens || 0;
          dailyMap[day].cacheHitTokens += record.cacheHitTokens || 0;
          dailyMap[day].requests += 1;

          // 按模型聚合
          const model = record.model || 'unknown';
          if (!dailyMap[day].models[model]) {
            dailyMap[day].models[model] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, requests: 0 };
          }
          dailyMap[day].models[model].promptTokens += record.promptTokens || 0;
          dailyMap[day].models[model].completionTokens += record.completionTokens || 0;
          dailyMap[day].models[model].totalTokens += record.totalTokens || 0;
          dailyMap[day].models[model].cacheHitTokens += record.cacheHitTokens || 0;
          dailyMap[day].models[model].requests += 1;
        } catch (e) {
          // 跳过损坏的行
        }
      }

      this._dailyCache = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date));
    } catch (e) {
      console.error('[TokenTracker] 重建缓存失败:', e.message);
    }
  }

  /**
   * 添加到最近记录列表（保持最多 500 条）
   */
  _addToRecent(record) {
    this.recentRecords.unshift(record);
    if (this.recentRecords.length > 500) {
      this.recentRecords.pop();
    }
  }

  /**
   * 记录一条 token 用量
   * @param {object} entry
   * @param {string} entry.model - 原始模型名（如 gpt-5.4）
   * @param {string} [entry.targetModel] - 目标模型名（如 deepseek-v4-flash）
   * @param {number} entry.promptTokens - 提示 tokens（含缓存命中）
   * @param {number} entry.completionTokens - 生成 tokens
   * @param {number} entry.totalTokens - 总 tokens
   * @param {number} [entry.cacheHitTokens] - 缓存命中 tokens（如 prompt_tokens_details.cached_tokens）
   * @param {string} [entry.host] - 来源域名
   */
  record(entry) {
    const now = new Date();
    const record = {
      date: now.toISOString().substring(0, 10), // YYYY-MM-DD
      timestamp: now.toISOString(),
      model: entry.model || 'unknown',
      targetModel: entry.targetModel || '',
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      totalTokens: entry.totalTokens || (entry.promptTokens || 0) + (entry.completionTokens || 0),
      cacheHitTokens: entry.cacheHitTokens || 0,
      host: entry.host || '',
    };

    // 追加入 JSONL 文件
    this._appendToFile(record);

    // 更新内存缓存
    this._addToRecent(record);
    this._updateDailyCache(record);
  }

  /**
   * 追加一行到 JSONL 文件
   */
  _appendToFile(record) {
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (e) {
      console.error('[TokenTracker] 写入失败:', e.message);
    }
  }

  /**
   * 更新每日聚合缓存
   */
  _updateDailyCache(record) {
    const day = record.date;
    let dayEntry = this._dailyCache.find(d => d.date === day);
    if (!dayEntry) {
      dayEntry = { date: day, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, requests: 0, models: {} };
      this._dailyCache.unshift(dayEntry);
    }

    dayEntry.promptTokens += record.promptTokens;
    dayEntry.completionTokens += record.completionTokens;
    dayEntry.totalTokens += record.totalTokens;
    dayEntry.cacheHitTokens += record.cacheHitTokens || 0;
    dayEntry.requests += 1;

    // 按模型聚合
    const model = record.model;
    if (!dayEntry.models[model]) {
      dayEntry.models[model] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, requests: 0 };
    }
    dayEntry.models[model].promptTokens += record.promptTokens;
    dayEntry.models[model].completionTokens += record.completionTokens;
    dayEntry.models[model].totalTokens += record.totalTokens;
    dayEntry.models[model].cacheHitTokens += record.cacheHitTokens || 0;
    dayEntry.models[model].requests += 1;

    // 保持按日期降序
    this._dailyCache.sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * 获取聚合统计
   * @returns {object}
   */
  getStats() {
    const today = new Date().toISOString().substring(0, 10);
    const now = new Date();

    // 计算本周起始
    const dayOfWeek = now.getDay();
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    const weekStart = monday.toISOString().substring(0, 10);

    // 计算本月起始
    const monthStart = now.toISOString().substring(0, 7) + '-01';

    // 按日聚合计算各维度
    const todayStats = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0, requests: 0 };
    const weekStats = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0, requests: 0 };
    const monthStats = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0, requests: 0 };
    const allTimeStats = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0, requests: 0 };

    for (const day of this._dailyCache) {
      allTimeStats.promptTokens += day.promptTokens;
      allTimeStats.completionTokens += day.completionTokens;
      allTimeStats.cacheHitTokens += day.cacheHitTokens || 0;
      allTimeStats.totalTokens += day.totalTokens;
      allTimeStats.requests += day.requests;

      if (day.date === today) {
        todayStats.promptTokens += day.promptTokens;
        todayStats.completionTokens += day.completionTokens;
        todayStats.cacheHitTokens += day.cacheHitTokens || 0;
        todayStats.totalTokens += day.totalTokens;
        todayStats.requests += day.requests;
      }

      if (day.date >= weekStart) {
        weekStats.promptTokens += day.promptTokens;
        weekStats.completionTokens += day.completionTokens;
        weekStats.cacheHitTokens += day.cacheHitTokens || 0;
        weekStats.totalTokens += day.totalTokens;
        weekStats.requests += day.requests;
      }

      if (day.date >= monthStart) {
        monthStats.promptTokens += day.promptTokens;
        monthStats.completionTokens += day.completionTokens;
        monthStats.cacheHitTokens += day.cacheHitTokens || 0;
        monthStats.totalTokens += day.totalTokens;
        monthStats.requests += day.requests;
      }
    }

    // 按模型聚合（全部时间）
    const modelStats = {};
    for (const day of this._dailyCache) {
      for (const [model, data] of Object.entries(day.models)) {
        if (!modelStats[model]) {
          modelStats[model] = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, totalTokens: 0, requests: 0 };
        }
        modelStats[model].promptTokens += data.promptTokens;
        modelStats[model].completionTokens += data.completionTokens;
        modelStats[model].cacheHitTokens += data.cacheHitTokens || 0;
        modelStats[model].totalTokens += data.totalTokens;
        modelStats[model].requests += data.requests;
      }
    }

    return {
      today: todayStats,
      thisWeek: weekStats,
      thisMonth: monthStats,
      allTime: allTimeStats,
      daily: this._dailyCache,
      models: modelStats,
      recentRecords: this.recentRecords.slice(0, 100),
    };
  }

  /**
   * 从请求体和响应体中提取 token 用量
   * 静态方法，可在 proxy-server 中直接调用
   *
   * @param {string} requestBody - 请求体 JSON 字符串
   * @param {string} responseBody - 响应体字符串
   * @param {object} [responseHeaders] - 响应头（用于判断是否流式）
   * @returns {{ promptTokens: number, completionTokens: number, totalTokens: number }|null}
   */
  static extractUsage(requestBody, responseBody, responseHeaders) {
    if (!responseBody || !responseBody.length) return null;

    // 尝试从非流式 JSON 响应中提取
    try {
      const resp = JSON.parse(responseBody);
      if (resp.usage) {
        const u = resp.usage;
        const promptTokens = u.prompt_tokens || u.input_tokens || 0;
        const completionTokens = u.completion_tokens || u.output_tokens || 0;
        // 缓存命中 tokens（DeepSeek 等返回 prompt_tokens_details.cached_tokens）
        const cacheHitTokens = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
        return {
          promptTokens,
          completionTokens,
          cacheHitTokens,
          totalTokens: u.total_tokens || promptTokens + completionTokens,
        };
      }
      // 有些供应商直接在根级别返回 token 数
      if (resp.prompt_tokens || resp.completion_tokens) {
        return {
          promptTokens: resp.prompt_tokens || 0,
          completionTokens: resp.completion_tokens || 0,
          cacheHitTokens: (resp.prompt_tokens_details && resp.prompt_tokens_details.cached_tokens) || 0,
          totalTokens: resp.total_tokens || (resp.prompt_tokens || 0) + (resp.completion_tokens || 0),
        };
      }
    } catch (e) {
      // 不是 JSON，可能是流式响应
    }

    // 尝试从流式 SSE 响应中提取（最后一条 data 可能包含 usage）
    const isStreaming = responseHeaders && (
      (responseHeaders['content-type'] || '').includes('text/event-stream') ||
      (responseHeaders['Content-Type'] || '').includes('text/event-stream')
    );

    if (isStreaming || responseBody.includes('\n')) {
      // 从最后几行查找包含 usage 的 data
      const lines = responseBody.split('\n');
      // 从后往前找最多 20 行
      const startIdx = Math.max(0, lines.length - 20);
      for (let i = lines.length - 1; i >= startIdx; i--) {
        const line = lines[i].trim();
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.substring(6);
            if (dataStr === '[DONE]') continue;
            const chunk = JSON.parse(dataStr);
            if (chunk.usage) {
              const u = chunk.usage;
              const promptTokens = u.prompt_tokens || u.input_tokens || 0;
              const completionTokens = u.completion_tokens || u.output_tokens || 0;
              const cacheHitTokens = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
              return {
                promptTokens,
                completionTokens,
                cacheHitTokens,
                totalTokens: u.total_tokens || promptTokens + completionTokens,
              };
            }
            // Anthropic 格式的流式 usage
            if (chunk.type === 'message_delta' && chunk.usage) {
              const u = chunk.usage;
              return {
                promptTokens: u.input_tokens || 0,
                completionTokens: u.output_tokens || 0,
                cacheHitTokens: 0,
                totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
              };
            }
          } catch (e) {
            // 跳过解析失败的行
          }
        }
      }
    }

    return null;
  }

  /**
   * 从请求体中提取模型名
   * @param {string} body - 请求体 JSON 字符串
   * @returns {string|null}
   */
  static extractModel(body) {
    if (!body) return null;
    try {
      const req = JSON.parse(body);
      return req.model || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 判断请求路径是否为 LLM 推理端点
   */
  static isLLMInferencePath(pathname) {
    const llmPaths = [
      '/v1/chat/completions', '/api/v1/chat/completions',
      '/v1/messages',
      '/v1/completions', '/api/v1/completions',
    ];
    return llmPaths.some(p => pathname === p || pathname.startsWith(p + '?'));
  }
}

module.exports = TokenTracker;
