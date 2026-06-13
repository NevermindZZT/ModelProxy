const { URL } = require('url');
const logger = require('./logger');
const OpenAIBackedAdapter = require('./adapters/openai-adapter');
const AnthropicAdapter = require('./adapters/anthropic-adapter');

/**
 * LLM 推理请求的路径特征列表
 * 用于智能拦截时判断请求是否为 LLM 推理请求
 */
const LLM_INFERENCE_PATHS = [
  '/chat/completions',
  '/v1/chat/completions',
  '/completions',
  '/v1/completions',
  '/embeddings',
  '/v1/embeddings',
  '/v1/chat',
  '/chat',
];

class RequestRouter {
  constructor(configManager) {
    this.configManager = configManager;
    
    // 初始化适配器 — 传入 configManager 使其支持热加载
    this.openaiAdapter = new OpenAIBackedAdapter(configManager);
    this.anthropicAdapter = new AnthropicAdapter(configManager);

    // 监听配置变更，更新内部状态
    this._unwatch = configManager.onChange((config) => {
      this._refreshDomains(config);
      // 适配器会自动读取最新配置
    });
  }

  /**
   * 获取当前配置（快捷方式）
   */
  get _config() {
    return this.configManager.get();
  }

  /**
   * 刷新域名拦截列表
   */
  _refreshDomains(config) {
    this._interceptDomains = new Set(config.intercept_domains || []);
    this._smartInterceptDomains = new Set(config.smart_intercept_domains || []);
  }

  /**
   * 获取拦截域名列表（惰性初始化）
   */
  get interceptDomains() {
    if (!this._interceptDomains) {
      this._refreshDomains(this._config);
    }
    return this._interceptDomains;
  }

  /**
   * 获取智能拦截域名列表
   */
  get smartInterceptDomains() {
    if (!this._smartInterceptDomains) {
      this._refreshDomains(this._config);
    }
    return this._smartInterceptDomains;
  }

  /**
   * 判断请求域名是否在直接拦截列表中
   */
  shouldIntercept(hostname) {
    return this.interceptDomains.has(hostname);
  }

  /**
   * 判断请求域名是否在智能拦截列表中
   * 智能拦截域名会进行 MITM 解密，但仅拦截 LLM 推理请求
   */
  isSmartInterceptDomain(hostname) {
    return this.smartInterceptDomains.has(hostname);
  }

  /**
   * 判断是否为需要拦截的域名（直接拦截 OR 智能拦截）
   */
  shouldInterceptOrSmart(hostname) {
    return this.shouldIntercept(hostname) || this.isSmartInterceptDomain(hostname);
  }

  /**
   * 检测请求是否为 LLM 推理请求
   * 通过检查 HTTP 方法和请求体内容来判断
   * 
   * @param {string} method - HTTP 方法
   * @param {string} pathname - 请求路径
   * @param {object} headers - 请求头
   * @param {string} body - 请求体
   * @returns {boolean} 是否为 LLM 推理请求
   */
  static isLLMRequest(method, pathname, headers, body) {
    // 方法检查：必须是 POST
    if (method !== 'POST') return false;

    // 路径检查：如果路径匹配已知的 LLM 端点，直接判定为 LLM 请求
    const pathLower = pathname.toLowerCase();
    for (const llmPath of LLM_INFERENCE_PATHS) {
      if (pathLower === llmPath || pathLower.startsWith(llmPath + '?')) {
        return true;
      }
    }

    // 内容类型检查：必须是 JSON
    const contentType = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) return false;

    // 请求体检查：必须有 body 且包含 LLM 特征字段
    if (!body || body.length === 0) return false;

    try {
      const parsed = JSON.parse(body);
      // 必须包含 model 字段
      if (!parsed.model) return false;
      // 且包含至少一个 LLM 推理相关的字段
      const llmFields = ['messages', 'prompt', 'max_tokens', 'stream', 'temperature', 
                         'top_p', 'frequency_penalty', 'presence_penalty', 'n', 'stop'];
      return llmFields.some(field => parsed[field] !== undefined);
    } catch (e) {
      // 不是 JSON，不是 LLM 请求
      return false;
    }
  }

  /**
   * 获取拦截域名列表（用于日志展示）
   */
  getInterceptDomains() {
    return [...this.interceptDomains];
  }

  /**
   * 获取智能拦截域名列表（用于日志展示）
   */
  getSmartInterceptDomains() {
    return [...this.smartInterceptDomains];
  }

  /**
   * 路由并处理已拦截的请求
   */
  async routeIntercepted(method, hostname, pathname, headers, body) {
    logger.info(`\n=== 拦截请求 ===`);
    logger.info(`  ${method} https://${hostname}${pathname}`);

    // 先尝试用 Anthropic 适配器处理
    if (hostname === 'api.anthropic.com' && this.anthropicAdapter.canHandle(method, pathname)) {
      logger.info('  使用 Anthropic 适配器');
      return this.anthropicAdapter.handle(method, pathname, headers, body);
    }

    // 使用 OpenAI 适配器（处理 OpenAI 和其他兼容的 API）
    if (this.openaiAdapter.canHandle(method, pathname)) {
      logger.info('  使用 OpenAI 适配器');
      return this.openaiAdapter.handle(method, pathname, headers, body);
    }

    // 如果都不匹配，返回错误
    logger.warn(`  未适配的请求: ${method} ${pathname}`);
    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: {
          message: `未适配的请求: ${method} ${pathname}，请在路由器中扩展此路径`,
          type: 'proxy_error',
        },
      }),
    };
  }
}

// 导出 LLM 路径常量供其他模块使用
RequestRouter.LLM_INFERENCE_PATHS = LLM_INFERENCE_PATHS;

module.exports = RequestRouter;
