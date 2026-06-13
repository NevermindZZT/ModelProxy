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
   * 处理请求
   */
  async handle(method, pathname, headers, body) {
    const targetUrl = this.targetBaseUrl + pathname;
    logger.info(`[OpenAI→Target] ${method} ${pathname}`);

    if (method === 'GET' && pathname === '/v1/models') {
      return this.handleModels();
    }

    if (method === 'POST') {
      if (pathname === '/v1/chat/completions') {
        return this.handleChatCompletions(body);
      }
      if (pathname === '/v1/completions') {
        return this.handleCompletions(body);
      }
    }

    // 默认直接透传
    return this.forwardToTarget(method, targetUrl, headers, body);
  }

  /**
   * 处理聊天补全请求
   */
  async handleChatCompletions(body) {
    // 解析请求体
    let requestBody;
    try {
      requestBody = JSON.parse(body);
    } catch (e) {
      return this.errorResponse(400, 'Invalid JSON in request body');
    }

    // 映射模型名称
    const originalModel = requestBody.model || '';
    requestBody.model = this.mapModel(originalModel);
    
    logger.info(`  模型映射: ${originalModel} → ${requestBody.model}`);

    // 转发到目标 API
    return this.forwardToTarget('POST', this.targetBaseUrl + '/v1/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    }, JSON.stringify(requestBody));
  }

  /**
   * 处理文本补全请求
   */
  async handleCompletions(body) {
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
      'Authorization': `Bearer ${this.apiKey}`,
    }, JSON.stringify(requestBody));
  }

  /**
   * 处理模型列表请求
   */
  async handleModels() {
    const responseBody = JSON.stringify({
      object: 'list',
      data: [
        {
          id: this.defaultModel,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'model-proxy',
        },
        ...Object.values(this.modelMapping)
          .filter(m => m !== 'default')
          .map(m => ({
            id: m,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'model-proxy',
          }))
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

  /**
   * 转发请求到目标 API
   */
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
        timeout: 300000, // 5 分钟超时
      };

      // 确保 Authorization header 使用目标的 API Key
      options.headers['Authorization'] = `Bearer ${this.apiKey}`;

      const lib = isHttps ? https : http;
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          
          logger.debug(`  目标响应状态: ${res.statusCode}`);

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
