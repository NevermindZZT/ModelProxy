const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('../logger');

/**
 * Anthropic 兼容适配器
 * 
 * 拦截来自 Copilot 的 Anthropic API 请求，转发到目标兼容 OpenAI 格式的供应商（如 DeepSeek）
 * 由于 Anthropic 和 OpenAI 的消息格式不同，需要做格式转换
 * 
 * Anthropic Messages API → OpenAI Chat Completions API
 * 
 * 支持的端点：
 *   - POST /v1/messages  →  OpenAI /v1/chat/completions
 *   - GET  /v1/models    →  模型列表
 */
class AnthropicAdapter {
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
   */
  getModelConfig(modelId) {
    if (this.models[modelId]) {
      return this.models[modelId];
    }
    return null;
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
   * 获取模型的名称（显示名）
   */
  getModelName(modelId) {
    const config = this.getModelConfig(modelId);
    return (config && config.name) || modelId;
  }

  canHandle(method, pathname) {
    const anthropicPaths = [
      '/v1/messages',
      '/v1/models',
      '/v1/complete',
    ];
    return anthropicPaths.some(p => pathname === p || pathname.startsWith(p + '?'));
  }

  /**
   * 从请求头中提取 API Key
   * Anthropic 支持两种认证方式：
   *   - x-api-key 头（Anthropic 标准方式）
   *   - Authorization: Bearer 头（OpenAI 兼容方式）
   * 优先使用原始请求中的密钥，而非配置文件中的 api_key
   */
  static extractApiKey(headers) {
    // 先检查 x-api-key（Anthropic 的标准认证头）
    const xApiKey = headers['x-api-key'];
    if (xApiKey && xApiKey.trim()) {
      return xApiKey.trim();
    }
    // 再检查 Authorization: Bearer
    const authHeader = headers['authorization'] || headers['Authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }
    return null;
  }

  async handle(method, pathname, headers, body) {
    logger.info(`[Anthropic→Target] ${method} ${pathname}`);

    // 模型列表请求不需要 API Key，直接处理
    if (method === 'GET' && pathname === '/v1/models') {
      return this.handleModels();
    }

    // 其他请求需要 API Key：使用 Copilot 中填写的 API Key
    const requestApiKey = AnthropicAdapter.extractApiKey(headers) || this.apiKey;
    if (!requestApiKey) {
      logger.warn('  未找到 API Key（请在 Copilot 中填写或在配置文件中设置）');
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          error: { message: 'API Key is required. Please fill it in Copilot settings or config.yaml', type: 'proxy_error' },
        }),
      };
    }

    if (!headers['x-api-key'] && !headers['authorization'] && !headers['Authorization']) {
      logger.info('  使用配置文件中的 API Key');
    } else {
      logger.info('  使用 Copilot 中填写的 API Key');
    }

    if (method === 'POST' && pathname === '/v1/messages') {
      return this.handleMessages(body, requestApiKey);
    }

    return this.errorResponse(404, `Unsupported endpoint: ${method} ${pathname}`);
  }

  /**
   * 将 Anthropic Messages API 请求转换为 OpenAI Chat Completions API 请求
   * 并转发到目标供应商
   */
  async handleMessages(body, apiKey) {
    let anthropicReq;
    try {
      anthropicReq = JSON.parse(body);
    } catch (e) {
      return this.errorResponse(400, 'Invalid JSON in request body');
    }

    // 转换模型名
    const originalModel = anthropicReq.model || '';
    const targetModel = this.mapModel(originalModel);
    logger.info(`  模型映射: ${originalModel} → ${targetModel}`);

    // 构建 OpenAI 格式的请求
    const openaiReq = this.anthropicToOpenAI(anthropicReq, targetModel);
    this._lastOriginalModel = originalModel; // 保存原始模型名，供 forwardToTarget 中的响应转换使用

    // 转发到目标 API，使用传入的 API Key
    const response = await this.forwardToTarget('POST', 
      this.targetBaseUrl + '/v1/chat/completions',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      JSON.stringify(openaiReq),
      apiKey
    );

    // ★ 在响应头中添加上下文窗口大小信息
    const contextWindow = this.getContextWindow(originalModel) || this.getContextWindow('default');
    if (contextWindow) {
      response.headers['x-llm-context-window'] = String(contextWindow);
      response.headers['x-model-context-window'] = String(contextWindow);
      response.headers['x-max-tokens'] = String(contextWindow);
    }

    return response;
  }

  /**
   * Anthropic Messages → OpenAI Chat Completions 格式转换
   */
  anthropicToOpenAI(anthropicReq, targetModel) {
    const openaiReq = {
      model: targetModel,
      messages: [],
      max_tokens: anthropicReq.max_tokens || 4096,
      stream: anthropicReq.stream || false,
    };

    // 可选参数
    if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
    if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
    if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;

    // 转换 system 消息
    let systemContent = null;
    if (anthropicReq.system) {
      if (typeof anthropicReq.system === 'string') {
        systemContent = anthropicReq.system;
      } else if (Array.isArray(anthropicReq.system)) {
        systemContent = anthropicReq.system
          .map(b => b.text || '')
          .filter(Boolean)
          .join('\n');
      }
    }

    // 转换消息
    for (const msg of anthropicReq.messages || []) {
      if (msg.role === 'user') {
        const content = this.anthropicContentToOpenAI(msg.content);
        openaiReq.messages.push({ role: 'user', content });
      } else if (msg.role === 'assistant') {
        const content = this.anthropicContentToOpenAI(msg.content);
        openaiReq.messages.push({ role: 'assistant', content });
      }
    }

    // 如果有 system 消息，插入到开头
    if (systemContent) {
      openaiReq.messages.unshift({ role: 'system', content: systemContent });
    }

    return openaiReq;
  }

  /**
   * Anthropic 的内容格式 → OpenAI 的 content string
   */
  anthropicContentToOpenAI(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(block => {
          if (block.type === 'text') return block.text;
          if (block.type === 'image') return '[Image]';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return String(content || '');
  }

  /**
   * OpenAI 响应 → Anthropic 响应格式转换
   */
  openAIResponseToAnthropic(openaiBody, originalModel) {
    try {
      const openaiResp = JSON.parse(openaiBody);

      if (openaiResp.error) {
        return JSON.stringify({
          type: 'error',
          error: {
            type: openaiResp.error.type || 'api_error',
            message: openaiResp.error.message || 'Unknown error',
          },
        });
      }

      const choice = openaiResp.choices && openaiResp.choices[0];
      const anthropicResp = {
        id: openaiResp.id || ('msg_' + Date.now().toString(36)),
        type: 'message',
        role: 'assistant',
        content: [],
        model: originalModel,
        stop_reason: this.mapStopReason(choice?.finish_reason),
        stop_sequence: null,
        usage: openaiResp.usage ? {
          input_tokens: openaiResp.usage.prompt_tokens || 0,
          output_tokens: openaiResp.usage.completion_tokens || 0,
        } : undefined,
      };

      if (choice?.message?.content) {
        anthropicResp.content.push({
          type: 'text',
          text: choice.message.content,
        });
      }

      return JSON.stringify(anthropicResp);
    } catch (e) {
      return openaiBody; // 回退到原始响应
    }
  }

  /**
   * 流式响应转换
   */
  transformStreamChunk(chunk, originalModel) {
    const line = chunk.toString('utf-8').trim();
    if (!line.startsWith('data: ')) return null;
    
    const data = line.substring(6);
    if (data === '[DONE]') {
      return Buffer.from('data: [DONE]\n\n');
    }

    try {
      const openaiChunk = JSON.parse(data);
      const choice = openaiChunk.choices && openaiChunk.choices[0];
      const delta = choice?.delta;

      const anthropicChunk = {
        type: 'content_block_delta',
        index: choice?.index || 0,
        delta: {
          type: 'text_delta',
          text: delta?.content || '',
        },
      };

      if (delta?.content) {
        return Buffer.from(
          JSON.stringify(anthropicChunk) + '\n'
        );
      }

      // 处理开始的 content_block_start
      if (delta?.role === 'assistant') {
        const startChunk = {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        };
        return Buffer.from(JSON.stringify(startChunk) + '\n');
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  mapStopReason(finishReason) {
    const map = {
      'stop': 'end_turn',
      'length': 'max_tokens',
      'content_filter': 'content_filter',
    };
    return map[finishReason] || finishReason || 'end_turn';
  }

  async handleModels() {
    const now = new Date().toISOString();

    // 收集所有源模型名
    const modelIds = Object.keys(this.models);
    for (const key of Object.keys(this.modelMapping)) {
      if (key !== 'default' && !modelIds.includes(key)) {
        modelIds.push(key);
      }
    }

    const uniqueModels = [...new Set(modelIds)];

    const models = uniqueModels.map(id => {
      const config = this.getModelConfig(id);
      const cw = this.getContextWindow(id);
      const maxOutput = (config && config.max_output_tokens) || 64000;
      const supportsVision = (config && config.vision === true);

      return {
        type: 'model',
        id: id,
        display: this.getModelName(id),
        created_at: now,
        max_input_tokens: cw,
        context_window: cw,
        max_output_tokens: maxOutput,
        capabilities: {
          vision: supportsVision,
        },
      };
    });

    const responseBody = JSON.stringify({ data: models });

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
        timeout: 300000,
      };

      // 使用传入的 API Key（来自原始请求）向目标供应商认证
      options.headers['Authorization'] = `Bearer ${apiKey}`;

      const lib = isHttps ? https : http;
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          
          // 如果是流式响应，直接透传
          if (res.headers['content-type']?.includes('text/event-stream')) {
            let body = rawBody.toString('utf-8');
            // ★ 重写流式响应中的模型名
            const origModel = this._lastOriginalModel || '';
            if (origModel) {
              const lines = body.split('\n');
              let rewritten = false;
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.startsWith('data: ') && line.includes('"model"')) {
                  try {
                    const dataStr = line.substring(6);
                    if (dataStr === '[DONE]') continue;
                    const chunk = JSON.parse(dataStr);
                    if (chunk.model) {
                      chunk.model = origModel;
                      lines[i] = 'data: ' + JSON.stringify(chunk);
                      rewritten = true;
                    }
                  } catch (e) { /* skip */ }
                }
              }
              if (rewritten) {
                body = lines.join('\n');
                logger.info(`  ✅ Anthropic 流式响应模型名已重写为: ${origModel}`);
              }
            }
            resolve({
              statusCode: res.statusCode,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'X-Proxy': 'ModelProxy',
              },
              body: body,
              isStream: true,
            });
            return;
          }

          // 非流式响应，转换格式
          const origModel = this._lastOriginalModel || '';
          const responseBody = this.openAIResponseToAnthropic(rawBody.toString('utf-8'), origModel);
          
          const responseHeaders = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(responseBody),
            'Access-Control-Allow-Origin': '*',
            'X-Proxy': 'ModelProxy',
          };

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
        resolve(this.errorResponse(504, 'Target API timeout'));
      });

      if (body) req.write(body);
      req.end();
    });
  }

  mapModel(originalModel) {
    if (!originalModel) return originalModel;
    // 新格式：从 models 中查找
    const modelConfig = this.getModelConfig(originalModel);
    if (modelConfig && modelConfig.target_model) return modelConfig.target_model;
    // 旧格式：精确匹配
    if (this.modelMapping[originalModel]) return this.modelMapping[originalModel];
    
    for (const [pattern, target] of Object.entries(this.modelMapping)) {
      if (pattern === 'default') continue;
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(originalModel)) return target;
      } catch (e) {}
    }
    // 未配置映射时原样返回
    return originalModel;
  }

  errorResponse(statusCode, message) {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message },
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

module.exports = AnthropicAdapter;
