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
  constructor(config) {
    this.targetBaseUrl = config.target.base_url.replace(/\/+$/, '');
    this.apiKey = config.target.api_key;
    this.modelMapping = config.target.model_mapping || {};
    this.defaultModel = this.modelMapping.default || 'deepseek-chat';
  }

  canHandle(method, pathname) {
    const anthropicPaths = [
      '/v1/messages',
      '/v1/models',
      '/v1/complete',
    ];
    return anthropicPaths.some(p => pathname === p || pathname.startsWith(p + '?'));
  }

  async handle(method, pathname, headers, body) {
    logger.info(`[Anthropic→Target] ${method} ${pathname}`);

    if (method === 'GET' && pathname === '/v1/models') {
      return this.handleModels();
    }

    if (method === 'POST' && pathname === '/v1/messages') {
      return this.handleMessages(body);
    }

    return this.errorResponse(404, `Unsupported endpoint: ${method} ${pathname}`);
  }

  /**
   * 将 Anthropic Messages API 请求转换为 OpenAI Chat Completions API 请求
   * 并转发到目标供应商
   */
  async handleMessages(body) {
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

    // 转发到目标 API
    return this.forwardToTarget('POST', 
      this.targetBaseUrl + '/v1/chat/completions',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      JSON.stringify(openaiReq)
    );
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
    const responseBody = JSON.stringify({
      data: [
        {
          type: 'model',
          id: this.defaultModel,
          display: this.defaultModel,
          created_at: new Date().toISOString(),
        },
      ],
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

  forwardToTarget(method, url, headers, body) {
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

      options.headers['Authorization'] = `Bearer ${this.apiKey}`;

      const lib = isHttps ? https : http;
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          
          // 如果是流式响应，直接透传
          if (res.headers['content-type']?.includes('text/event-stream')) {
            resolve({
              statusCode: res.statusCode,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'X-Proxy': 'ModelProxy',
              },
              body: rawBody.toString('utf-8'),
              isStream: true,
            });
            return;
          }

          // 非流式响应，转换格式
          const responseBody = this.openAIResponseToAnthropic(rawBody.toString('utf-8'), '');
          
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
    if (!originalModel) return this.defaultModel;
    if (this.modelMapping[originalModel]) return this.modelMapping[originalModel];
    
    for (const [pattern, target] of Object.entries(this.modelMapping)) {
      if (pattern === 'default') continue;
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(originalModel)) return target;
      } catch (e) {}
    }
    return this.defaultModel;
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
