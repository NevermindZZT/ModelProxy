const https = require('https');
const { URL } = require('url');
const logger = require('../logger');

/**
 * GitHub Copilot API 适配器
 * 
 * 拦截来自 Copilot 客户端对 api.individual.githubcopilot.com 的请求，
 * 转发到 GitHub 的真实服务器，并修改模型配置响应中的上下文窗口大小。
 * 
 * GitHub Copilot 通过此 API 获取模型配置（包括上下文窗口），
 * 如果返回的上下文窗口是默认值（100K），会导致长对话被截断。
 * 此适配器将上下文窗口重写为配置文件中 target.context_window 设置的值。
 */
class CopilotAdapter {
  constructor(configManager) {
    this.configManager = configManager;
  }

  /**
   * 获取当前 target 配置
   */
  get _targetConfig() {
    return this.configManager.get().target || {};
  }

  /**
   * 获取模型映射
   */
  get modelMapping() {
    return this._targetConfig.model_mapping || {};
  }

  /**
   * 获取默认上下文窗口大小
   */
  getDefaultContextWindow() {
    const cw = this._targetConfig.context_window || null;
    if (!cw) return null;
    if (typeof cw === 'object') {
      return cw.default || null;
    }
    return cw;
  }

  /**
   * 获取指定模型的上下文窗口大小
   */
  getContextWindow(modelId) {
    const cw = this._targetConfig.context_window || null;
    if (!cw) return null;
    if (typeof cw === 'object') {
      return cw[modelId] || cw.default || null;
    }
    return cw;
  }

  /**
   * 获取第一个源模型名（model_mapping 的第一个键，排除 'default'）
   * 用于在 SSE 响应中替换 gpt-4o-mini-2024-07-18 等小模型名
   */
  _getFirstSourceModel() {
    const sourceModels = Object.keys(this.modelMapping).filter(k => k !== 'default');
    return sourceModels.length > 0 ? sourceModels[0] : '';
  }

  /**
   * 判断是否处理此请求
   * Copilot API 的所有请求都通过此适配器
   */
  canHandle(method, pathname) {
    return true; // 处理所有 copilot API 请求
  }

  /**
   * 处理请求
   * 转发到 GitHub 的真实服务器，并修改响应中的上下文窗口
   */
  async handle(method, pathname, headers, body) {
    logger.info(`[Copilot→GitHub] ${method} ${pathname}`);
    
    // ★ 记录所有请求路径，帮助定位模型列表接口
    if (method === 'GET') {
      logger.info(`[Copilot] 📡 GET 请求路径: ${pathname}`);
    }
    if (method === 'POST') {
      const bodyStr = body ? body.toString('utf-8') : '';
      const preview = bodyStr.substring(0, 200);
      logger.info(`[Copilot] 📡 POST 请求路径: ${pathname}, body预览: ${preview}`);
      
      // ★ 从请求体中提取模型名
      if (bodyStr) {
        try {
          const reqObj = JSON.parse(bodyStr);
          if (reqObj.model) {
            this._lastCopilotRequestModel = reqObj.model;
            logger.info(`[Copilot] 📡 请求模型名: ${reqObj.model}`);
          }
          // 如果是 /chat/completions，打印完整请求体的关键字段
          if (pathname === '/chat/completions') {
            logger.info(`[Copilot] 📡 /chat/completions 请求: model=${reqObj.model || '?'}, messages=${reqObj.messages?.length || 0}条, stream=${reqObj.stream}, max_tokens=${reqObj.max_tokens}`);
          }
        } catch (e) {
          // 解析失败则忽略
        }
      }
    }

    // ★ SSE模型名重写策略：
    // Copilot API /chat/completions 的 SSE 响应中 model 通常是 gpt-4o-mini-2024-07-18
    // 我们需要重写为用户实际选择的模型（或第一个源模型），这样 Copilot 客户端会从 /models 列表中找到 1M 上下文
    // 注意：不直接使用请求体中的 model（可能也是小模型），而是使用我们配置的源模型
    let requestModel = '';
    if (pathname === '/chat/completions') {
      // 对于 /chat/completions 的 SSE 响应，强制使用第一个源模型名
      requestModel = this._getFirstSourceModel();
      if (requestModel) {
        logger.info(`[Copilot] 🔄 将对 /chat/completions 的 SSE 响应重写模型名: -> ${requestModel}`);
      }
    } else if (this._lastCopilotRequestModel) {
      requestModel = this._lastCopilotRequestModel;
    }

    // 构建转发请求到 GitHub Copilot API
    return this.forwardToGitHub(method, pathname, headers, body, requestModel);
  }

  /**
   * 将请求转发到 GitHub 的真实 Copilot API 服务器
   */
  forwardToGitHub(method, pathname, headers, body, requestModel) {
    return new Promise((resolve, reject) => {
      const hostname = 'api.individual.githubcopilot.com';
      const options = {
        hostname: hostname,
        port: 443,
        path: pathname,
        method: method,
        headers: {
          ...headers,
          'Host': hostname,
        },
        timeout: 60000,
        rejectUnauthorized: false,
      };

      // 删除逐跳头
      delete options.headers['proxy-connection'];
      delete options.headers['proxy-authorization'];

      const lib = https;
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let rawBody = Buffer.concat(chunks);
          let bodyStr = rawBody.toString('utf-8');
          // ★ 调试：记录 /models 原始响应结构（不做任何修改）
          if (pathname === '/models' || pathname === '/v1/models') {
            this._logRawModelsResponse(bodyStr);
          }

          const contentType = (res.headers['content-type'] || '').toLowerCase();
          
          // ★ 调试：记录响应信息
          logger.info(`[Copilot] ${pathname} 响应 Content-Type: ${res.headers['content-type'] || '未知'}`);
          logger.info(`[Copilot] ${pathname} 响应体前200字符: ${bodyStr.substring(0, 200).replace(/\n/g, '\\n')}`);

          // 尝试修改响应中的上下文窗口 — 同时支持 JSON 和 SSE 格式
          if (contentType.includes('application/json') || contentType.includes('text/json') || contentType.includes('text/event-stream')) {
            // 如果是 /models 路径，注入自定义模型
            if (pathname === '/models' || pathname === '/v1/models') {
              if (contentType.includes('application/json') || contentType.includes('text/json')) {
                bodyStr = this._injectCustomModels(bodyStr);
                bodyStr = this._rewriteContextWindow(bodyStr);
              }
            } else {
              // 非 /models 路径，尝试重写上下文窗口
              bodyStr = this._rewriteBodyContextWindow(bodyStr, contentType, requestModel);
            }
          }

          // 构建响应头
          const responseHeaders = {
            'Content-Type': res.headers['content-type'] || 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Proxy': 'ModelProxy',
          };
          
          // 保留一些重要的原始头
          const preserveHeaders = ['date', 'cache-control', 'expires', 'x-request-id', 'x-trace-id'];
          for (const key of preserveHeaders) {
            if (res.headers[key]) {
              responseHeaders[key] = res.headers[key];
            }
          }

          // 添加上下文窗口头
          const cw = this.getDefaultContextWindow();
          if (cw) {
            responseHeaders['x-llm-context-window'] = String(cw);
            responseHeaders['x-model-context-window'] = String(cw);
          }

          resolve({
            statusCode: res.statusCode,
            headers: responseHeaders,
            body: bodyStr,
          });
        });
      });

      req.on('error', (err) => {
        logger.error(`[Copilot] 转发到 GitHub 失败: ${err.message}`);
        resolve({
          statusCode: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { message: `Proxy error: ${err.message}`, type: 'proxy_error' } }),
        });
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('[Copilot] 转发到 GitHub 超时');
        resolve({
          statusCode: 504,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { message: 'Gateway timeout', type: 'proxy_error' } }),
        });
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * 记录 /models 原始响应结构（不做任何修改）
   * 用于查看 GitHub Copilot API 原始返回的模型格式
   */
  _logRawModelsResponse(bodyStr) {
    try {
      const obj = JSON.parse(bodyStr);
      const data = obj.data || obj.models || obj;
      const arr = Array.isArray(data) ? data : (Array.isArray(obj) ? obj : []);
      
      if (arr.length > 0) {
        // 打印第一个完整模型的 JSON 结构（仅第一个，避免刷屏）
        const firstModel = JSON.stringify(arr[0], null, 2);
        logger.info(`[Copilot] 📋 /models 原始第一个模型条目:\n${firstModel.substring(0, 1500)}`);
        logger.info(`[Copilot] 📋 /models 共 ${arr.length} 个模型`);
        
        // 打印所有模型名列表（name + id）
        const names = arr.map(m => {
          const n = m.name || '?';
          const i = m.id || '';
          return i && i !== n ? `${n}(${i})` : n;
        }).join(', ');
        logger.info(`[Copilot] 📋 模型名列表: ${names.substring(0, 500)}`);
      }
    } catch (e) {
      logger.debug(`[Copilot] /models 原始响应解析失败: ${e.message}`);
    }
  }

  /**
   * 记录 JSON 响应的结构（仅 key 路径，不记录值）
   * 用于调试，帮助理解 GitHub Copilot API 的响应格式
   */
  _logJsonStructure(pathname, bodyStr) {
    try {
      const obj = JSON.parse(bodyStr.substring(0, 10000)); // 只解析前 10KB
      const paths = [];
      this._walkJsonPaths(obj, '', paths);
      logger.info(`[Copilot] ${pathname} 响应结构: ${paths.join(', ')}`);
    } catch (e) {
      // 解析失败则跳过
    }
  }

  /**
   * 递归遍历 JSON 对象，收集所有 key 路径
   */
  _walkJsonPaths(obj, prefix, paths, depth = 0) {
    if (depth > 3) return; // 限制深度防止刷屏
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
        // 用第一个元素代表数组结构
        const itemPrefix = prefix ? prefix + '[]' : '[]';
        paths.push(itemPrefix);
        this._walkJsonPaths(obj[0], itemPrefix, paths, depth + 1);
      } else {
        paths.push(prefix ? prefix + '[]' : '[]');
      }
    } else {
      for (const key of Object.keys(obj)) {
        const fullKey = prefix ? prefix + '.' + key : key;
        const val = obj[key];
        if (typeof val === 'object' && val !== null) {
          paths.push(fullKey + ':{' + typeof val + '}');
          this._walkJsonPaths(val, fullKey, paths, depth + 1);
        } else {
          paths.push(fullKey + ':' + typeof val);
        }
      }
    }
  }

  /**
   * 重写 JSON 响应中的上下文窗口大小
   * 
   * 遍历 JSON 对象，查找并替换与上下文窗口相关的字段值。
   * 支持的字段名：
   *   - max_input_tokens
   *   - context_window
   *   - max_tokens
   *   - max_context_length
   *   - token_limit
   *   - max_input
   *   - max_prompt_tokens
   *   - max_completion_tokens
   *   - context_length
   *   - max_prompt_length
   */
  _rewriteContextWindow(bodyStr) {
    if (!bodyStr || bodyStr.length === 0) return bodyStr;

    try {
      const obj = JSON.parse(bodyStr);
      const cw = this.getDefaultContextWindow();
      if (!cw) return bodyStr;

      // 要查找和替换的上下文窗口字段名
      const contextFields = [
        'max_input_tokens', 'context_window', 'max_tokens',
        'max_context_length', 'token_limit', 'max_input',
        'max_prompt_tokens', 'max_completion_tokens',
        'context_length', 'max_prompt_length',
        'max_context_window_tokens',
      ];

      // 遍历并重写
      const rewritten = this._deepRewrite(obj, contextFields, cw);
      
      if (rewritten) {
        const newBody = JSON.stringify(obj);
        logger.info(`  ✅ Copilot API 响应中的上下文窗口已重写为: ${cw}`);
        return newBody;
      }

      return bodyStr;
    } catch (e) {
      // 不是 JSON，原样返回
      return bodyStr;
    }
  }

  /**
   * 深度遍历 JSON 对象，重写匹配的字段
   */
  _deepRewrite(obj, fields, targetValue) {
    if (!obj || typeof obj !== 'object') return false;
    
    let rewritten = false;

    // 遍历所有字段
    for (const key of Object.keys(obj)) {
      const keyLower = key.toLowerCase();
      
      // 检查是否是上下文窗口字段（不区分大小写）
      if (fields.some(f => f.toLowerCase() === keyLower)) {
        const val = obj[key];
        // 只重写数值类型的字段，且值小于目标值（说明是默认值需要被覆盖）
        if (typeof val === 'number' && val < targetValue) {
          obj[key] = targetValue;
          rewritten = true;
          logger.debug(`  [Copilot] 重写 ${key}: ${val} → ${targetValue}`);
        }
      } else if (typeof obj[key] === 'object') {
        // 递归遍历子对象
        if (this._deepRewrite(obj[key], fields, targetValue)) {
          rewritten = true;
        }
      }
    }

    return rewritten;
  }

  /**
   * 向 GitHub Copilot API 的 /models 响应中注入自定义模型
   * 
   * 从配置文件 model_mapping 中获取自定义模型名（如 gpt-5.4），
   * 将这些模型注入到 GitHub Copilot 返回的模型列表中，
   * 并将 max_prompt_tokens 设置为配置的上下文窗口大小。
   * 这样 Copilot 客户端就能识别这些自定义模型并使用正确的上下文窗口。
   */
  _injectCustomModels(bodyStr) {
    if (!bodyStr || bodyStr.length === 0) return bodyStr;

    try {
      const obj = JSON.parse(bodyStr);
      
      // 获取自定义模型列表（model_mapping 的键，排除 'default'）
      const sourceModels = Object.keys(this.modelMapping).filter(k => k !== 'default');
      if (sourceModels.length === 0) return bodyStr;

      // 也添加目标模型名（model_mapping 的值），如 deepseek-v4-flash
      const targetModels = [...new Set(Object.values(this.modelMapping).filter(v => v !== 'default'))];
      const allModelsToInject = [...new Set([...sourceModels, ...targetModels])];

      // 查找模型数组 — 支持两种格式：
      // 1. 顶层数组: [{...}, {...}]
      // 2. 对象中的字段: { "models": [{...}, {...}] } 或 { "data": [{...}, {...}] }
      let modelsArray = null;
      let container = null;
      let containerKey = null;

      if (Array.isArray(obj)) {
        modelsArray = obj;
        container = obj;
      } else {
        for (const key of ['models', 'data']) {
          if (Array.isArray(obj[key])) {
            modelsArray = obj[key];
            container = obj;
            containerKey = key;
            break;
          }
        }
      }

      if (!modelsArray) {
        logger.debug(`[Copilot] /models 响应格式未知，无法注入自定义模型: ${bodyStr.substring(0, 200)}`);
        return bodyStr;
      }

      // 找一个模板模型来复制结构（用第一个模型作为模板）
      const templateModel = modelsArray.length > 0 ? modelsArray[0] : null;

      // 已有的模型名集合（用于去重）
      const existingModelNames = new Set();
      for (const m of modelsArray) {
        const name = m.name || m.id || m.model || '';
        if (name) existingModelNames.add(name);
      }

      let injectedCount = 0;
      for (const customModel of allModelsToInject) {
        if (existingModelNames.has(customModel)) continue; // 已存在则跳过

        const cw = this.getContextWindow(customModel) || this.getDefaultContextWindow();
        if (!cw) continue;

        // 基于模板创建新模型条目
        let newModel;
        if (templateModel) {
          // 深拷贝模板并修改关键字段
          newModel = JSON.parse(JSON.stringify(templateModel));
          this._setModelField(newModel, customModel, cw);
        } else {
          // 没有模板，创建最小模型条目
          newModel = this._createMinimalModel(customModel, cw);
        }

        modelsArray.push(newModel);
        injectedCount++;
        logger.info(`  ✅ 注入自定义模型: ${customModel} (max_prompt_tokens=${cw})`);
        // 调试：打印前 3 个注入模型的 capabilities 结构
        if (injectedCount <= 3) {
          const caps = JSON.stringify(newModel.capabilities || newModel).substring(0, 300);
          logger.debug(`  [Copilot] ${customModel} capabilities: ${caps}`);
        }
      }

      if (injectedCount > 0) {
        // 如果是对象格式，更新容器
        if (containerKey && container) {
          container[containerKey] = modelsArray;
        }
        return JSON.stringify(container || modelsArray);
      }

      return bodyStr;
    } catch (e) {
      logger.warn(`[Copilot] 注入自定义模型失败: ${e.message}`);
      return bodyStr;
    }
  }

  /**
   * 在模型对象中设置 name/ID 和上下文窗口字段
   * 必须同时设置 id 和 name，因为 Copilot 用 id 来识别模型
   */
  _setModelField(modelObj, modelName, contextWindow) {
    // 设置所有标识字段：id（内部标识）、name（显示名）、model（备用）
    for (const nameField of ['id', 'name', 'model']) {
      if (modelObj[nameField] !== undefined) {
        modelObj[nameField] = modelName;
      }
    }
    // 如果没有 id 字段，添加一个
    if (modelObj.id === undefined) {
      modelObj.id = modelName;
    }
    // 递归设置 max_prompt_tokens 等上下文窗口字段
    this._deepRewriteSingle(modelObj, modelName, contextWindow);
  }

  /**
   * 深度查找并替换单个模型对象中的字段
   */
  _deepRewriteSingle(obj, modelName, targetValue, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    
    for (const key of Object.keys(obj)) {
      const keyLower = key.toLowerCase();
      // 查找上下文窗口字段
      if (['max_prompt_tokens', 'max_input_tokens', 'context_window', 
           'max_tokens', 'token_limit', 'max_context_length', 'max_input',
           'max_context_window_tokens'].includes(keyLower)) {
        obj[key] = targetValue;
      } else if (typeof obj[key] === 'object') {
        this._deepRewriteSingle(obj[key], modelName, targetValue, depth + 1);
      }
    }
  }

  /**
   * 创建最小模型条目（无模板可用时）
   */
  _createMinimalModel(modelName, contextWindow) {
    return {
      name: modelName,
      capabilities: {
        max_prompt_tokens: contextWindow,
      },
    };
  }

  /**
   * 重写响应体中的上下文窗口（同时支持 JSON 和 SSE 格式）
   * 
   * SSE（Server-Sent Events）格式的响应由多行 "data: {...}" 组成，
   * 整体不能被 JSON.parse 解析，需要逐行处理。
   * 此方法尝试先解析为 JSON，如果失败则按 SSE 格式逐行处理。
   * 
   * @param {string} bodyStr - 响应体
   * @param {string} contentType - Content-Type 头
   * @param {string} requestModel - 原始请求中的模型名（用于重写 SSE 中的 model 字段）
   */
  _rewriteBodyContextWindow(bodyStr, contentType, requestModel = '') {
    if (!bodyStr || bodyStr.length === 0) return bodyStr;

    const cw = this.getDefaultContextWindow();
    if (!cw) return bodyStr;

    // 字段名列表
    const contextFields = [
      'max_input_tokens', 'context_window', 'max_tokens',
      'max_context_length', 'token_limit', 'max_input',
      'max_prompt_tokens', 'max_completion_tokens',
      'context_length', 'max_prompt_length',
      'max_context_window_tokens',
    ];

    // 先尝试作为完整 JSON 解析
    try {
      const obj = JSON.parse(bodyStr);
      const fields = [...contextFields];
      let rewritten = this._deepRewrite(obj, fields, cw);
      // 如果请求有模型名，也重写 model 字段
      if (requestModel && obj.model && obj.model !== requestModel) {
        logger.info(`  ✅ Copilot API JSON 响应模型名已重写: ${obj.model} → ${requestModel}`);
        obj.model = requestModel;
        rewritten = true;
      }
      if (rewritten) {
        logger.info(`  ✅ Copilot API 响应上下文窗口已重写为: ${cw}`);
        return JSON.stringify(obj);
      }
      // JSON 解析成功但没有匹配字段，输出结构日志
      this._logJsonStructure('', bodyStr);
      return bodyStr;
    } catch (e) {
      // 不是完整 JSON，尝试按 SSE 格式处理
    }

    // SSE 格式：逐行处理 "data: {...}"
    if (contentType.includes('text/event-stream') || bodyStr.includes('\ndata: ') || bodyStr.startsWith('data: ')) {
      const lines = bodyStr.split('\n');
      let rewritten = false;
      let modelRewritten = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('data: ')) {
          const dataStr = line.substring(6);
          if (dataStr === '[DONE]') continue;
          try {
            const chunk = JSON.parse(dataStr);
            // 重写上下文窗口字段
            if (this._deepRewrite(chunk, contextFields, cw)) {
              rewritten = true;
            }
            // 重写模型名（如果请求有模型名且 SSE 中的模型名不同）
            if (requestModel && chunk.model && chunk.model !== requestModel) {
              chunk.model = requestModel;
              modelRewritten = true;
            }
            if (rewritten || modelRewritten) {
              lines[i] = 'data: ' + JSON.stringify(chunk);
            }
          } catch (e) {
            // 解析失败则跳过该行
          }
        }
      }
      if (modelRewritten) {
        logger.info(`  ✅ Copilot API SSE 模型名已重写为: ${requestModel}`);
      }
      if (rewritten) {
        bodyStr = lines.join('\n');
        logger.info(`  ✅ Copilot API SSE 响应上下文窗口已重写为: ${cw}`);
      } else if (!modelRewritten && !rewritten) {
        // 没重写任何字段，打印 SSE 结构用于调试
        this._logSseStructure(bodyStr);
      } else {
        bodyStr = lines.join('\n');
      }
    }

    return bodyStr;
  }

  /**
   * 记录 SSE 响应的结构
   */
  _logSseStructure(bodyStr) {
    const lines = bodyStr.split('\n');
    const dataLines = lines.filter(l => l.startsWith('data: '));
    if (dataLines.length > 0) {
      // 只解析第一个和最后一个 data 事件的结构
      const first = dataLines[0].substring(6);
      const last = dataLines[dataLines.length - 1].substring(6);
      try {
        const firstObj = JSON.parse(first);
        const paths = [];
        this._walkJsonPaths(firstObj, '', paths);
        logger.info(`[Copilot] SSE 首个事件结构: ${paths.join(', ')}`);
      } catch (e) {}
      try {
        const lastObj = JSON.parse(last);
        const paths = [];
        this._walkJsonPaths(lastObj, '', paths);
        logger.info(`[Copilot] SSE 最后一个事件结构: ${paths.join(', ')}`);
      } catch (e) {}
    }
  }
}

module.exports = CopilotAdapter;
