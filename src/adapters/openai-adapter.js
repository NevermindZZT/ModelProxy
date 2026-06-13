const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('../logger');

/**
 * OpenAI 兼容适配器
 * 
 * 拦截来自 Copilot 的 OpenAI API 请求，转发到目标兼容 OpenAI 格式的供应商（如 DeepSeek）
 * 
 * 支持的端点：
 *   - POST /v1/chat/completions  →  聊天补全
 *   - POST /v1/completions       →  文本补全
 *   - POST /v1/embeddings        →  嵌入向量
 *   - GET  /v1/models            →  模型列表
 */
class OpenAIBackedAdapter {
  constructor(config) {
    this.targetBaseUrl = config.target.base_url.replace(/\/+$/, '');
    this.apiKey = config.target.api_key;
    this.modelMapping = config.target.model_mapping || {};
    this.defaultModel = this.modelMapping.default || 'deepseek-chat';
    // context_window 支持两种格式：
    //   数字: 所有模型共用（如 1048576）
    //   对象: 按源模型名区分（如 { default: 1048576, "gpt-4o-mini": 65536 }）
    this.contextWindowConfig = config.target.context_window || null;
    // 模型思考/推理配置（支持按模型配置或统一配置）
    this.rawThinkingConfig = config.target.thinking || null;
  }

  /**
   * 获取指定模型的 thinking 配置
   * 支持两种格式：
   *   1) 统一格式: { enabled: false, effort: "medium" } — 所有模型共用
   *   2) 按模型格式: { default: { enabled: false }, "deepseek-v4-flash": { enabled: true } }
   *   按模型格式时，key 为目标模型名（即 model_mapping 的值），而非 Copilot 端的源模型名
   */
  getThinkingConfig(modelId) {
    if (!this.rawThinkingConfig) return null;
    // 统一格式：顶层有 enabled 字段
    if (this.rawThinkingConfig.enabled !== undefined) {
      return this.rawThinkingConfig;
    }
    // 按模型格式：按模型名查找，找不到用 default
    return this.rawThinkingConfig[modelId] || this.rawThinkingConfig.default || null;
  }

  /**
   * 获取指定模型的上下文窗口大小
   * 优先按模型名查找，找不到则用默认值
   */
  getContextWindow(modelId) {
    if (!this.contextWindowConfig) return null;
    if (typeof this.contextWindowConfig === 'object') {
      return this.contextWindowConfig[modelId] || this.contextWindowConfig.default || null;
    }
    return this.contextWindowConfig;
  }

  /**
   * 判断是否处理此请求
   */
  canHandle(method, pathname) {
    const openaiPaths = [
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/embeddings',
      '/v1/models',
      '/v1/audio/transcriptions',
      '/v1/audio/speech',
    ];
    return openaiPaths.some(p => pathname === p || pathname.startsWith(p + '?'));
  }

  /**
   * 从请求头中提取 API Key（Bearer Token）
   * 优先使用原始请求中的 Authorization 头，而非配置文件中的 api_key
   */
  static extractBearerToken(headers) {
    const authHeader = headers['authorization'] || headers['Authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }
    return null;
  }

  /**
   * 处理请求
   * 从原始请求的 Authorization 头中提取 API Key，用于转发到目标供应商
   * 
   * 注意：/v1/models（模型列表刷新）不需要 API Key，先处理路由再检查认证。
   */
  async handle(method, pathname, headers, body) {
    const targetUrl = this.targetBaseUrl + pathname;
    logger.info(`[OpenAI→Target] ${method} ${pathname}`);

    // 模型列表请求不需要 API Key（返回静态列表），直接处理
    if (method === 'GET' && pathname === '/v1/models') {
      return this.handleModels();
    }

    // 其他请求需要 API Key：优先使用原始请求中的 Authorization 头
    const requestApiKey = OpenAIBackedAdapter.extractBearerToken(headers) || this.apiKey;
    if (!requestApiKey) {
      logger.warn('  未找到 API Key（配置文件中未设置且请求中未携带 Authorization 头）');
      return this.errorResponse(401, 'API Key is required. Please set it in Android Studio Copilot plugin or config.yaml');
    }

    if (!headers['authorization'] && !headers['Authorization']) {
      logger.info('  使用配置文件中的 API Key（请求未携带 Authorization 头）');
    } else {
      logger.info('  使用原始请求中的 API Key');
    }

    if (method === 'POST') {
      if (pathname === '/v1/chat/completions') {
        return this.handleChatCompletions(body, requestApiKey);
      }
      if (pathname === '/v1/completions') {
        return this.handleCompletions(body, requestApiKey);
      }
    }

    // 默认直接透传
    return this.forwardToTarget(method, targetUrl, headers, body, requestApiKey);
  }

  /**
   * 处理聊天补全请求
   * 支持根据配置注入 thinking/reasoning 参数（如 reasoning_effort）
   */
  async handleChatCompletions(body, apiKey) {
    // 解析请求体
    let requestBody;
    try {
      requestBody = JSON.parse(body);
    } catch (e) {
      return this.errorResponse(400, 'Invalid JSON in request body');
    }

    // 映射模型名称
    const originalModel = requestBody.model || '';
    const targetModel = this.mapModel(originalModel);
    requestBody.model = targetModel;
    
    logger.info(`  模型映射: ${originalModel} → ${targetModel}`);

    // 注入 thinking/reasoning 参数（按目标模型名配置，如果请求本身已携带则不覆盖）
    const modelThinking = this.getThinkingConfig(targetModel);
    const hasThinkingConfig = !!modelThinking;
    logger.info(`  thinking 配置查找: targetModel=${targetModel}, 找到=${hasThinkingConfig}, enabled=${modelThinking?.enabled}`);
    if (modelThinking && modelThinking.enabled) {
      // DeepSeek V4 的 thinking 参数格式: thinking: { type: "enabled" }
      if (requestBody.thinking === undefined) {
        requestBody.thinking = { type: 'enabled' };
        logger.info('  注入 thinking: { type: "enabled" }');
      }

      // reasoning_effort: DeepSeek 支持 "high" 和 "max"，低/中会自动映射到 high
      if (modelThinking.effort && requestBody.reasoning_effort === undefined) {
        const effort = modelThinking.effort;
        // 将 low/medium 映射为 high（DeepSeek 的行为）
        const mappedEffort = (effort === 'low' || effort === 'medium') ? 'high' : effort;
        requestBody.reasoning_effort = mappedEffort;
        logger.info(`  注入 thinking: reasoning_effort=${mappedEffort}（原始配置=${effort}）`);
      }
    }

    // 转发到目标 API
    const finalBody = JSON.stringify(requestBody);
    // 记录发送给 DeepSeek 的完整请求（只保留关键字段，避免刷屏）
    const streamMode = requestBody.stream ? 'stream=true' : 'stream=false';
    logger.info(`  发送到 DeepSeek: model=${targetModel}, ${streamMode}, thinking=${JSON.stringify(requestBody.thinking)}, reasoning_effort=${requestBody.reasoning_effort || '未设置'}`);
    return this.forwardToTarget('POST', this.targetBaseUrl + '/v1/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }, finalBody, apiKey);
  }

  /**
   * 处理文本补全请求
   */
  async handleCompletions(body, apiKey) {
    let requestBody;
    try {
      requestBody = JSON.parse(body);
    } catch (e) {
      return this.errorResponse(400, 'Invalid JSON in request body');
    }

    const originalModel = requestBody.model || '';
    requestBody.model = this.mapModel(originalModel);
    
    logger.info(`  模型映射: ${originalModel} → ${requestBody.model}`);

    return this.forwardToTarget('POST', this.targetBaseUrl + '/v1/completions', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }, JSON.stringify(requestBody), apiKey);
  }

  /**
   * 处理模型列表请求
   * 
   * 返回 Copilot 端可识别的源模型名（model_mapping 的键），而非目标模型名。
   * 这样 Copilot 能认出 gpt-4o、claude-3-5-sonnet 等模型，自动匹配正确的上下文大小。
   * 同时附带 context_window 信息，供支持该字段的客户端使用。
   */
  async handleModels() {
    // 收集所有源模型名（model_mapping 的键，排除 'default'）
    const sourceModels = Object.keys(this.modelMapping).filter(k => k !== 'default');
    // 去重（多个源模型可能映射到同一目标）
    const uniqueModels = [...new Set(sourceModels)];

    const models = uniqueModels.map(id => {
      const cw = this.getContextWindow(id);
      const model = {
        id: id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'model-proxy',
      };
      if (cw) {
        model.max_input_tokens = cw;
        model.context_window = cw;
      }
      return model;
    });

    // 确保默认模型也在列表中
    const hasDefault = models.some(m => m.id === this.defaultModel);
    if (!hasDefault && !uniqueModels.includes(this.defaultModel)) {
      const cw = this.getContextWindow(this.defaultModel);
      models.push({
        id: this.defaultModel,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'model-proxy',
        ...(cw ? { max_input_tokens: cw, context_window: cw } : {}),
      });
    }

    const responseBody = JSON.stringify({
      object: 'list',
      data: models,
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(responseBody),
        'Access-Control-Allow-Origin': '*',
      },
      body: responseBody,
    };
  }

  /**
   * 转发请求到目标 API
   * @param {string} method - HTTP 方法
   * @param {string} url - 目标 URL
   * @param {object} headers - 请求头
   * @param {string} body - 请求体
   * @param {string} apiKey - 用于转发的 API Key（来自原始请求或配置文件）
   */
  forwardToTarget(method, url, headers, body, apiKey) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: {
          ...headers,
          'Host': parsedUrl.hostname,
        },
        timeout: 300000, // 5 分钟超时
      };

      // 使用传入的 API Key（来自原始请求）向目标供应商认证
      options.headers['Authorization'] = `Bearer ${apiKey}`;

      const lib = isHttps ? https : http;
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          
          logger.debug(`  目标响应状态: ${res.statusCode}`);
          // 检查 DeepSeek 响应中是否包含 reasoning_content
          if (responseBody.includes('reasoning_content')) {
            logger.info('  ✅ DeepSeek 响应中包含 reasoning_content（thinking 已生效）');
          } else if (res.statusCode >= 400) {
            // 如果是错误响应，打印前 500 字符帮助排查
            logger.warn(`  ❌ DeepSeek 返回错误 (${res.statusCode}): ${responseBody.substring(0, 500)}`);
          }

          // 过滤响应头，移除传输相关头
          const responseHeaders = {};
          const allowedHeaders = [
            'content-type', 'content-length', 'date', 'cache-control',
            'expires', 'access-control-allow-origin', 'access-control-allow-headers',
            'access-control-allow-methods', 'x-request-id',
          ];
          for (const [key, value] of Object.entries(res.headers)) {
            if (allowedHeaders.includes(key)) {
              responseHeaders[key] = value;
            }
          }
          responseHeaders['Access-Control-Allow-Origin'] = '*';
          responseHeaders['X-Proxy'] = 'ModelProxy';

          resolve({
            statusCode: res.statusCode,
            headers: responseHeaders,
            body: responseBody,
          });
        });
      });

      req.on('error', (err) => {
        logger.error(`  转发请求失败: ${err.message}`);
        resolve(this.errorResponse(502, `Target API error: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('  转发请求超时');
        resolve(this.errorResponse(504, 'Target API timeout'));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  mapModel(originalModel) {
    if (!originalModel) return this.defaultModel;
    
    // 精确匹配
    if (this.modelMapping[originalModel]) {
      return this.modelMapping[originalModel];
    }

    // 正则匹配
    for (const [pattern, target] of Object.entries(this.modelMapping)) {
      if (pattern === 'default') continue;
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(originalModel)) {
          return target;
        }
      } catch (e) {
        // 不是正则表达式，跳过
      }
    }

    return this.defaultModel;
  }

  errorResponse(statusCode, message) {
    const body = JSON.stringify({
      error: {
        message,
        type: 'proxy_error',
        code: statusCode,
      },
    });
    return {
      statusCode,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
      },
      body,
    };
  }
}

module.exports = OpenAIBackedAdapter;
