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
  constructor(configManager) {
    this.configManager = configManager;
  }

  /**
   * 获取当前 target 配置（每次调用都从 ConfigManager 读取，支持热加载）
   */
  get _targetConfig() {
    return this.configManager.get().target || {};
  }

  /**
   * 获取目标 Base URL
   */
  get targetBaseUrl() {
    return (this._targetConfig.base_url || 'https://api.deepseek.com').replace(/\/+$/, '');
  }

  /**
   * 获取配置文件中的 API Key
   */
  get apiKey() {
    return this._targetConfig.api_key || '';
  }

  /**
   * 获取模型映射（兼容旧的 model_mapping 格式）
   */
  get modelMapping() {
    return this._targetConfig.model_mapping || {};
  }

  /**
   * 获取模型定义列表（新格式）
   */
  get models() {
    return this._targetConfig.models || {};
  }

  /**
   * 获取默认模型名
   */
  get defaultModel() {
    return this._targetConfig.default_model || 
           this.modelMapping.default || 
           'deepseek-chat';
  }

  /**
   * 获取默认上下文窗口大小
   */
  get defaultContextWindow() {
    return this._targetConfig.default_context_window || 1048576;
  }

  /**
   * 获取模型的完整配置
   * 优先从新格式 models 中查找，兼容旧格式 model_mapping + context_window + thinking
   */
  getModelConfig(modelId) {
    // 新格式：直接从 models 中获取
    if (this.models[modelId]) {
      return this.models[modelId];
    }
    return null;
  }

  /**
   * 将源模型名映射到目标模型名
   * 仅当配置中定义了该模型的映射时才映射，否则原样保留
   */
  mapModel(sourceModel) {
    // 新格式：从 models 中查找
    const modelConfig = this.getModelConfig(sourceModel);
    if (modelConfig && modelConfig.target_model) {
      return modelConfig.target_model;
    }
    // 旧格式：从 model_mapping 中查找
    if (this.modelMapping[sourceModel]) {
      return this.modelMapping[sourceModel];
    }
    // 未配置映射时，原样返回，不做默认映射
    return sourceModel;
  }

  /**
   * 获取指定模型的上下文窗口大小
   */
  getContextWindow(modelId) {
    // 新格式
    const modelConfig = this.getModelConfig(modelId);
    if (modelConfig && modelConfig.context_window) {
      return modelConfig.context_window;
    }
    // 旧格式
    const cw = this._targetConfig.context_window || null;
    if (cw) {
      if (typeof cw === 'object') {
        return cw[modelId] || cw.default || null;
      }
      return cw;
    }
    return this.defaultContextWindow;
  }

  /**
   * 获取指定目标模型的 thinking 配置
   * 新格式：从 models 中对应源模型的配置继承 thinking 能力
   * 旧格式：从独立的 thinking 配置中查找
   */
  getThinkingConfigForTarget(targetModel) {
    // 先查找新格式：遍历 models，找 target_model 匹配的源模型
    for (const [sourceId, config] of Object.entries(this.models)) {
      if (config.target_model === targetModel && config.thinking) {
        return {
          enabled: true,
          effort: config.reasoning_effort || 'high',
        };
      }
    }
    // 旧格式：从独立的 thinking 配置中查找
    const raw = this._targetConfig.thinking || null;
    if (raw) {
      if (raw.enabled !== undefined) {
        return raw;
      }
      return raw[targetModel] || raw.default || null;
    }
    return null;
  }

  /**
   * 获取模型的名称（显示名）
   */
  getModelName(modelId) {
    const config = this.getModelConfig(modelId);
    return (config && config.name) || modelId;
  }

  /**
   * 判断是否处理此请求
   */
  canHandle(method, pathname) {
    // OpenRouter 使用 /api/v1/ 路径，其他 OpenAI 兼容 API 使用 /v1/
    const openaiPaths = [
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/embeddings',
      '/v1/models',
      '/v1/audio/transcriptions',
      '/v1/audio/speech',
      // OpenRouter 兼容路径
      '/api/v1/chat/completions',
      '/api/v1/completions',
      '/api/v1/embeddings',
      '/api/v1/models',
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
  async handle(method, pathname, headers, body, hostname) {
    const targetUrl = this.targetBaseUrl + pathname;
    logger.info(`[OpenAI→Target] ${method} ${pathname}`);

    // ★ 使用客户端发送的 API Key 转发请求
    // 如果 Copilot 中配置了 API Key，优先使用它；否则用配置文件中的
    const clientApiKey = OpenAIBackedAdapter.extractBearerToken(headers);
    const configApiKey = this.apiKey;
    const requestApiKey = clientApiKey || configApiKey;
    if (!requestApiKey) {
      logger.warn('  未找到 API Key（请在 Copilot 中填写或在配置文件中设置）');
      return this.errorResponse(401, 'API Key is required');
    }
    if (clientApiKey) {
      logger.info('  使用 Copilot 中填写的 API Key');
    } else {
      logger.info('  使用配置文件中的 API Key');
    }

    // ★ 模型列表请求：获取真实供应商模型 + 合并自定义模型
    if (method === 'GET' && (pathname === '/v1/models' || pathname === '/api/v1/models' || pathname.startsWith('/v1/models?') || pathname.startsWith('/api/v1/models?'))) {
      // 模型列表：使用客户端 API Key 请求真实供应商
      return this.handleModels(hostname, method, pathname, headers, body, clientApiKey || configApiKey);
    }

    // ★ 标准化路径：OpenRouter 的 /api/v1/ → 目标供应商的 /v1/
    let upstreamPath = pathname;
    if (pathname.startsWith('/api/v1/')) {
      upstreamPath = pathname.replace('/api/v1/', '/v1/');
      logger.info(`  OpenRouter 路径标准化: ${pathname} → ${upstreamPath}`);
    }

    if (method === 'POST') {
      if (pathname === '/v1/chat/completions' || pathname === '/api/v1/chat/completions') {
        // ★ 聊天请求：使用配置文件的 API Key 转发到目标供应商
        // 客户端 API Key 是供应商特定的（如 OpenRouter），目标供应商可能不同
        return this.handleChatCompletions(body, configApiKey || clientApiKey, upstreamPath);
      }
      if (pathname === '/v1/completions' || pathname === '/api/v1/completions') {
        return this.handleCompletions(body, configApiKey || clientApiKey, upstreamPath);
      }
    }

    // 其他请求：用标准化路径转发
    const upstreamTargetUrl = this.targetBaseUrl + upstreamPath;
    return this.forwardToTarget(method, upstreamTargetUrl, headers, body, configApiKey || clientApiKey);
  }

  /**
   * 转发 OpenRouter 请求到真实 API 并记录响应
   * 用于调试：查看 OpenRouter 真实的模型列表格式
   */
  _forwardAndLogOpenRouter(method, pathname, headers, body) {
    return new Promise((resolve, reject) => {
      const lib = https;
      const options = {
        hostname: 'openrouter.ai',
        port: 443,
        path: pathname,
        method: method,
        headers: {
          ...headers,
          'Host': 'openrouter.ai',
        },
        timeout: 30000,
        rejectUnauthorized: false,
      };

      delete options.headers['proxy-connection'];
      delete options.headers['proxy-authorization'];

      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const bodyStr = rawBody.toString('utf-8');
          
          logger.info(`📡 [OpenRouter调试] 响应状态: ${res.statusCode}`);
          logger.info(`📡 [OpenRouter调试] 响应 Content-Type: ${res.headers['content-type'] || '未知'}`);
          logger.info(`📡 [OpenRouter调试] 响应体 (前3000字符):\n${bodyStr.substring(0, 3000)}`);
          
          // 如果是模型列表，打印结构信息
          try {
            const obj = JSON.parse(bodyStr);
            const data = obj.data || [];
            logger.info(`📡 [OpenRouter调试] 共 ${data.length} 个模型`);
            if (data.length > 0) {
              const first = JSON.stringify(data[0], null, 2);
              logger.info(`📡 [OpenRouter调试] 第一个模型完整结构:\n${first.substring(0, 2000)}`);
            }
          } catch (e) {
            logger.info(`📡 [OpenRouter调试] 响应不是 JSON: ${e.message}`);
          }

          // 构建响应头
          const responseHeaders = {
            'Content-Type': res.headers['content-type'] || 'application/json',
            'Access-Control-Allow-Origin': '*',
          };
          for (const key of ['date', 'cache-control']) {
            if (res.headers[key]) responseHeaders[key] = res.headers[key];
          }

          resolve({
            statusCode: res.statusCode,
            headers: responseHeaders,
            body: bodyStr,
          });
        });
      });

      req.on('error', (err) => {
        logger.error(`📡 [OpenRouter调试] 转发失败: ${err.message}`);
        resolve({
          statusCode: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { message: `OpenRouter proxy error: ${err.message}` } }),
        });
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('📡 [OpenRouter调试] 转发超时');
        resolve({
          statusCode: 504,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { message: 'OpenRouter gateway timeout' } }),
        });
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * 处理聊天补全请求
   * 支持根据配置注入 thinking/reasoning 参数（如 reasoning_effort）
   */
  async handleChatCompletions(body, apiKey, pathname) {
    // 解析请求体
    let requestBody;
    try {
      requestBody = JSON.parse(body);
    } catch (e) {
      logger.warn(`  ❌ JSON 解析失败: ${e.message}`);
      logger.warn(`  body 前200字符: ${(body || '').substring(0, 200)}`);
      logger.warn(`  body 长度: ${body ? body.length : 0}`);
      return this.errorResponse(400, 'Invalid JSON in request body');
    }

    // 映射模型名称
    const originalModel = requestBody.model || '';
    const targetModel = this.mapModel(originalModel);
    requestBody.model = targetModel;
    
    logger.info(`  模型映射: ${originalModel} → ${targetModel}`);

    // 注入 thinking/reasoning 参数（按目标模型名配置，如果请求本身已携带则不覆盖）
    const modelThinking = this.getThinkingConfigForTarget(targetModel);
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

    // 转发到目标 API，使用原始请求的路径
    // 例如：OpenRouter 用 /api/v1/chat/completions，OpenAI 用 /v1/chat/completions
    const finalBody = JSON.stringify(requestBody);
    const streamMode = requestBody.stream ? 'stream=true' : 'stream=false';
    logger.info(`  发送到目标: model=${targetModel}, ${streamMode}, path=${pathname}, thinking=${JSON.stringify(requestBody.thinking)}, reasoning_effort=${requestBody.reasoning_effort || '未设置'}`);
    const response = await this.forwardToTarget('POST', this.targetBaseUrl + pathname, {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }, finalBody, apiKey);

    // ★ 关键修复：将响应中的模型名重写回原始模型名
    // GitHub Copilot 根据响应中的 model 字段确定上下文窗口大小
    // 如果返回的是目标模型名（如 deepseek-chat），Copilot 不认识它，会回退到默认 100K
    // 重写回原始模型名（如 gpt-4o），Copilot 就能使用正确的上下文窗口
    if (response.body && originalModel) {
      const isStreaming = requestBody.stream || 
        (response.headers['content-type'] || '').includes('text/event-stream');
      
      if (isStreaming) {
        // 流式响应：逐行重写 SSE 事件中的 model 字段
        const lines = response.body.split('\n');
        let rewritten = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith('data: ') && line.includes('"model"')) {
            try {
              const dataStr = line.substring(6);
              if (dataStr === '[DONE]') continue;
              const chunk = JSON.parse(dataStr);
              if (chunk.model) {
                chunk.model = originalModel;
                lines[i] = 'data: ' + JSON.stringify(chunk);
                rewritten = true;
              }
            } catch (e) {
              // 解析失败则跳过该行
            }
          }
        }
        if (rewritten) {
          response.body = lines.join('\n');
          logger.info(`  ✅ 流式响应模型名已重写: ${targetModel} → ${originalModel}`);
        }
      } else {
        // 非流式响应：重写 JSON body 中的 model 字段
        try {
          const respObj = JSON.parse(response.body);
          if (respObj.model) {
            respObj.model = originalModel;
            response.body = JSON.stringify(respObj);
            // 更新 Content-Length
            if (response.headers['content-length']) {
              response.headers['content-length'] = Buffer.byteLength(response.body);
            }
            logger.info(`  ✅ 非流式响应模型名已重写: ${targetModel} → ${originalModel}`);
          }
        } catch (e) {
          logger.warn(`  无法解析响应 JSON，跳过模型名重写: ${e.message}`);
        }
      }
    }

    // ★ 在响应头中添加上下文窗口大小信息
    // GitHub Copilot 可能通过响应头来确定上下文窗口
    const contextWindow = this.getContextWindow(originalModel) || this.getContextWindow('default');
    if (contextWindow) {
      response.headers['x-llm-context-window'] = String(contextWindow);
      response.headers['x-model-context-window'] = String(contextWindow);
      response.headers['x-max-tokens'] = String(contextWindow);
    }

    return response;
  }

  /**
   * 处理文本补全请求
   */
  async handleCompletions(body, apiKey, pathname) {
    let requestBody;
    try {
      requestBody = JSON.parse(body);
    } catch (e) {
      return this.errorResponse(400, 'Invalid JSON in request body');
    }

    const originalModel = requestBody.model || '';
    requestBody.model = this.mapModel(originalModel);
    
    logger.info(`  模型映射: ${originalModel} → ${requestBody.model}`);

    const response = await this.forwardToTarget('POST', this.targetBaseUrl + pathname, {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }, JSON.stringify(requestBody), apiKey);

    // ★ 重写响应中的模型名
    if (response.body && originalModel) {
      try {
        const respObj = JSON.parse(response.body);
        if (respObj.model) {
          respObj.model = originalModel;
          response.body = JSON.stringify(respObj);
          if (response.headers['content-length']) {
            response.headers['content-length'] = Buffer.byteLength(response.body);
          }
        }
      } catch (e) {
        logger.warn(`  无法解析 completions 响应 JSON: ${e.message}`);
      }
    }

    // ★ 添加上下文窗口响应头
    const contextWindow = this.getContextWindow(originalModel) || this.getContextWindow('default');
    if (contextWindow) {
      response.headers['x-llm-context-window'] = String(contextWindow);
      response.headers['x-model-context-window'] = String(contextWindow);
      response.headers['x-max-tokens'] = String(contextWindow);
    }

    return response;
  }

  /**
   * 处理模型列表请求
   * 
   * 1. 从真实供应商 API 获取原始模型列表（使用 Copilot 中填写的 API Key）
   * 2. 合并配置中的自定义模型
   * 3. 原始模型的能力信息以供应商返回的为准
   */
  async handleModels(hostname, method, pathname, headers, body, apiKey) {
    const now = Math.floor(Date.now() / 1000);
    const isOpenRouter = hostname && hostname.includes('openrouter');
    
    // ★ 第一步：从目标供应商 API 获取原始模型列表
    let realModels = [];
    let targetHost = '';
    try {
      realModels = await this._fetchRealModels(hostname, method, pathname, headers, apiKey);
      const parsedUrl = new URL(this.targetBaseUrl);
      targetHost = parsedUrl.hostname;
      logger.info(`  [Models] 从 ${targetHost} 获取到 ${realModels.length} 个原始模型`);
    } catch (err) {
      logger.warn(`  [Models] 获取原始模型列表失败: ${err.message}，仅使用自定义模型`);
    }

    // ★ 第二步：将原始模型转为 OpenRouter 格式（确保 supported_parameters 兼容）
    const openRouterModels = [];
    const existingIds = new Set();
    
    for (const model of realModels) {
      const id = model.id || '';
      if (!id) continue;
      existingIds.add(id);
      
      // 从配置中查找该模型的自定义配置（如果有）
      const config = this.getModelConfig(id);
      const cw = this.getContextWindow(id) || (config && config.context_window) || this.defaultContextWindow;
      const maxOutput = (config && config.max_output_tokens) || 64000;
      const supportsVision = (config && config.vision === true);
      
      openRouterModels.push({
        id: id,
        name: model.name || model.id || id,
        created: model.created || now,
        description: `${targetHost} model: ${id}`,
        context_length: cw,
        architecture: {
          modality: supportsVision ? 'text+image->text' : 'text->text',
          input_modalities: supportsVision ? ['text', 'image'] : ['text'],
          output_modalities: ['text'],
          tokenizer: 'Custom',
          instruct_type: null,
        },
        pricing: { prompt: '0', completion: '0' },
        top_provider: {
          context_length: cw,
          max_completion_tokens: maxOutput,
          is_moderated: false,
        },
        per_request_limits: null,
        supported_parameters: [
          'max_tokens', 'temperature', 'top_p', 'stop',
          'frequency_penalty', 'presence_penalty',
          'tool_choice', 'tools', 'top_k',
        ],
        default_parameters: {},
        supported_voices: null,
        knowledge_cutoff: null,
        expiration_date: null,
      });
    }

    // ★ 第三步：添加自定义模型（来自配置）
    const customModelIds = Object.keys(this.models);
    
    for (const id of customModelIds) {
      if (existingIds.has(id)) continue; // 原始模型已存在，不覆盖
      
      const config = this.getModelConfig(id);
      const cw = this.getContextWindow(id) || (config && config.context_window) || this.defaultContextWindow;
      const maxOutput = (config && config.max_output_tokens) || 64000;
      const supportsVision = (config && config.vision === true);
      const supportsThinking = (config && config.thinking === true);

      const supportedParams = [
        'max_tokens', 'temperature', 'top_p', 'stop',
        'frequency_penalty', 'presence_penalty',
        'tool_choice', 'tools', 'top_k',
      ];
      if (supportsThinking) supportedParams.push('reasoning', 'include_reasoning');
      if (supportsVision) supportedParams.push('response_format');

      openRouterModels.push({
        id: id,
        name: this.getModelName(id),
        created: now,
        description: `ModelProxy: ${id} → ${this.mapModel(id)}`,
        context_length: cw,
        architecture: {
          modality: supportsVision ? 'text+image->text' : 'text->text',
          input_modalities: supportsVision ? ['text', 'image'] : ['text'],
          output_modalities: ['text'],
          tokenizer: 'Custom',
          instruct_type: null,
        },
        pricing: { prompt: '0', completion: '0' },
        top_provider: {
          context_length: cw,
          max_completion_tokens: maxOutput,
          is_moderated: false,
        },
        per_request_limits: null,
        supported_parameters: supportedParams,
        default_parameters: {},
        supported_voices: null,
        knowledge_cutoff: null,
        expiration_date: null,
      });
      logger.info(`  [Models]   添加自定义模型: ${id} (ctx=${cw}, thinking=${supportsThinking})`);
    }

    const responseBody = JSON.stringify({ data: openRouterModels });
    logger.info(`  [Models] 共返回 ${openRouterModels.length} 个模型 (OpenRouter格式)`);

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
   * 从目标供应商 API 获取模型列表
   * 使用 Copilot 中填写的 API Key
   */
  _fetchRealModels(hostname, method, pathname, headers, apiKey) {
    return new Promise((resolve, reject) => {
      // ★ 从目标供应商（targetBaseUrl）获取模型列表
      const parsedUrl = new URL(this.targetBaseUrl);
      const targetHost = parsedUrl.hostname;
      // 使用 base_url 的路径前缀 + /v1/models
      // 例如：https://opencode.ai/zen/go → /zen/go/v1/models
      // 例如：https://api.deepseek.com → /v1/models
      const basePath = parsedUrl.pathname.replace(/\/+$/, ''); // 去掉末尾斜杠
      const targetPath = basePath + '/v1/models';

      const lib = https;
      const options = {
        hostname: targetHost,
        port: 443,
        path: targetPath,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Host': targetHost,
        },
        timeout: 15000,
        rejectUnauthorized: false,
      };

      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const rawBody = Buffer.concat(chunks).toString('utf-8');
            
            // ★ 记录原始响应用于调试
            logger.info(`  [Models] ${targetHost}${targetPath} 响应: ${res.statusCode}`);
            
            if (res.statusCode !== 200) {
              logger.warn(`  [Models] ${targetHost} 返回 ${res.statusCode}: ${rawBody.substring(0, 200)}`);
              return resolve([]);
            }
            
            const obj = JSON.parse(rawBody);
            const data = obj.data || [];
            logger.info(`  [Models] 从 ${targetHost} 获取到 ${data.length} 个原始模型`);
            return resolve(data);
          } catch (e) {
            reject(new Error(`解析响应失败: ${e.message}`));
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
      req.end();
    });
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
