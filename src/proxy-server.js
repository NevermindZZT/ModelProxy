const https = require('https');
const http = require('http');
const { URL } = require('url');
const tls = require('tls');
const logger = require('./logger');
const { getOrCreateRootCA, generateCertForDomain } = require('./cert-manager');
const RequestRouter = require('./router');
const TokenTracker = require('./token-tracker');
const { getDataDir } = require('./paths');

class ProxyServer {
  constructor(configManager) {
    this.configManager = configManager;
    this.router = new RequestRouter(configManager);
    this.rootCA = null;
    this.recentRequests = []; // 保存最近的请求记录用于状态页展示
    this.startTime = new Date();
    this.tokenTracker = new TokenTracker(getDataDir());
  }

  /**
   * 获取当前配置（快捷方式）
   */
  get config() {
    return this.configManager.get();
  }

  addRequestLog(entry) {
    this.recentRequests.unshift({
      time: new Date().toISOString().substring(11, 19),
      ...entry,
    });
    if (this.recentRequests.length > 50) this.recentRequests.pop();
  }

  async start() {
    const host = this.config.proxy.host || '127.0.0.1';
    const port = this.config.proxy.port || 8080;

    // 初始化根 CA
    logger.info('正在初始化 SSL 证书...');
    this.rootCA = getOrCreateRootCA();

    // 创建 HTTP 代理服务器
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    server.on('connect', (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket, head);
    });

    server.listen(port, host, () => {
      logger.info('');
      logger.info('='.repeat(60));
      logger.info('  ModelProxy v1.0.4');
      logger.info('='.repeat(60));
      logger.info(`  ✅ 代理服务器已启动: http://${host}:${port}`);
      logger.info('');
      logger.info(`  📋 管理面板: http://${host}:${port}/_modelproxy/admin`);
      logger.info(`  📋 日志文件: ${logger.getLogFilePath()}`);
      logger.info(`  📋 日志级别: ${this.config.log_level || 'info'}`);
      logger.info('');
      logger.info('  📋 配置 Android Studio:');
      logger.info(`     Settings → HTTP Proxy → Manual → ${host}:${port}`);
      logger.info('');
      logger.info('  📋 等待请求中...（任何到达代理的请求都会打印在下方）');
      logger.info('');
      logger.info('  📋 直接拦截的供应商:');
      for (const domain of this.router.getInterceptDomains()) {
        logger.info(`    - ${domain}`);
      }
      const smartDomains = this.router.getSmartInterceptDomains();
      if (smartDomains.length > 0) {
        logger.info('  📋 智能拦截域名（仅拦截 LLM 推理请求）:');
        for (const domain of smartDomains) {
          logger.info(`    - ${domain}`);
        }
      }
      logger.info('');
      logger.info('  📋 目标供应商:');
      logger.info(`    ${this.config.target.base_url}`);
      logger.info(`    模型: ${this.config.target.model_mapping?.default || '未配置'}`);
      logger.info('');
      logger.info('  ⚠ 首次使用时，请安装根 CA 证书:');
      const certManager = require('./cert-manager');
      const certPemPath = certManager.getRootCACertPath();
      const certCrtPath = certManager.getRootCACrtPath();
      logger.info(`     CRT: ${certCrtPath}  (Windows 双击安装)`);
      logger.info(`     PEM: ${certPemPath}`);
      logger.info('');
      logger.info('='.repeat(60));
    });

    // 监听启动错误（如端口被占用），给出明确的错误信息
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error('');
        logger.error('='.repeat(60));
        logger.error(`  ❌ 端口 ${port} 已被占用！`);
        logger.error('');
        logger.error(`  可能原因: 已有 ModelProxy 实例在运行`);
        logger.error(`  解决方案: 运行以下命令杀掉旧进程:`);
        logger.error(`    netstat -ano | findstr ":${port}"`);
        logger.error(`    taskkill /PID <进程ID> /F`);
        logger.error('');
        logger.error('='.repeat(60));
      } else {
        logger.error(`❌ 服务器启动失败: ${err.message}`);
      }
      process.exit(1);
    });

  } // ← 这里闭合 start() 方法

  /**
   * 收集请求体数据
   */
  _collectBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
  }

  /**
   * 发送 JSON 响应
   */
  _jsonResponse(res, statusCode, data) {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(body);
  }

  /**
   * 处理普通 HTTP 请求
   */
  async handleRequest(req, res) {
    const clientAddr = req.socket?.remoteAddress || 'unknown';
    const url = req.url;

    // === CORS 预检请求 ===
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // === 管理后台 UI ===
    if (url === '/_modelproxy/admin') {
      return this.serveAdminPage(res);
    }

    // === 获取当前配置（JSON） ===
    if (url === '/_modelproxy/config' && req.method === 'GET') {
      return this._jsonResponse(res, 200, this.config);
    }

    // === 更新配置（JSON） ===
    if (url === '/_modelproxy/config' && req.method === 'PUT') {
      try {
        const body = await this._collectBody(req);
        const updates = JSON.parse(body);
        this.configManager.applyUpdates(updates);
        this.configManager.save();
        logger.info('[配置API] 配置已更新并保存');
        return this._jsonResponse(res, 200, { success: true, message: '配置已更新' });
      } catch (err) {
        logger.error(`[配置API] 更新失败: ${err.message}`);
        return this._jsonResponse(res, 400, { success: false, message: err.message });
      }
    }

    // === 重新加载配置文件 ===
    if (url === '/_modelproxy/reload' && req.method === 'POST') {
      this.configManager.load();
      logger.info('[配置API] 配置文件已重新加载');
      return this._jsonResponse(res, 200, { success: true, message: '配置已从文件重新加载' });
    }

    // === 列出可用配置文件 ===
    if (url === '/_modelproxy/configs' && req.method === 'GET') {
      const { getDataDir, getConfigName } = require('./paths');
      const fs = require('fs');
      const dir = getDataDir();
      let files = [];
      try {
        files = fs.readdirSync(dir)
          .filter(f => /^config-.+\.yaml$/.test(f) || f === 'config.yaml')
          .map(f => {
            const match = f.match(/^config(?:-(.+))?\.yaml$/);
            return { file: f, name: match ? (match[1] || 'default') : f, isActive: false };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        // 标记当前活动配置
        const activeConfigName = getConfigName();
        for (const f of files) {
          f.isActive = (f.name === (activeConfigName || 'default'));
        }
        if (!files.find(f => f.name === 'default')) {
          // 始终有一个默认配置选项
          files.unshift({ file: 'config.yaml', name: 'default', isActive: activeConfigName === '' });
        }
      } catch (e) {
        logger.error('[配置API] 列出配置文件失败:', e.message);
      }
      return this._jsonResponse(res, 200, { configs: files, active: getConfigName() || 'default' });
    }

    // === 切换配置文件 ===
    if (url === '/_modelproxy/switch-config' && req.method === 'POST') {
      try {
        const body = await this._collectBody(req);
        const data = JSON.parse(body);
        const configName = data.config || '';
        const { setConfigName, getConfigPath } = require('./paths');
        setConfigName(configName);
        this.configManager.load();
        logger.info(`[配置API] 已切换到配置文件: ${getConfigPath()}`);
        return this._jsonResponse(res, 200, { success: true, message: `已切换到: ${getConfigPath()}`, configPath: getConfigPath() });
      } catch (err) {
        return this._jsonResponse(res, 400, { success: false, message: err.message });
      }
    }

    // === 状态页面 ===
    if (url === '/' || url === '/_modelproxy/status') {
      return this.serveStatusPage(res);
    }

    // === 健康检查 ===
    if (url === '/_modelproxy/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        intercept_domains: this.router.getInterceptDomains(),
        target: this.config.target.base_url,
        version: '1.0.4',
      }));
      logger.info('[健康检查] 代理运行正常');
      return;
    }

    // === Token 用量统计 ===
    if (url === '/_modelproxy/stats/tokens') {
      const stats = this.tokenTracker.getStats();
      return this._jsonResponse(res, 200, stats);
    }

    // === 普通 HTTP 代理请求 ===
    logger.info(`[HTTP] ${req.method} ${url} (来源: ${clientAddr})`);
    this.addRequestLog({ type: 'HTTP', method: req.method, url, from: clientAddr });

    const parsedUrl = new URL(url, 'http://localhost');
    const hostname = parsedUrl.hostname || req.headers.host;

    if (hostname && this.router.shouldIntercept(hostname)) {
      logger.info(`[拦截] HTTP ${req.method} ${url}`);
    }

    this.forwardRequest(req, res);
  }

  /**
   * 处理 HTTPS CONNECT 隧道请求
   * 这是核心方法：拦截对指定域名的 HTTPS 请求
   */
  handleConnect(req, clientSocket, head) {
    const [hostname, portStr] = req.url.split(':');
    const port = parseInt(portStr) || 443;
    const clientAddr = clientSocket.remoteAddress || 'unknown';

    // 记录请求
    this.addRequestLog({ type: 'CONNECT', host: hostname, port, from: clientAddr });

    // ⭐ 所有 CONNECT 请求全部打印（info 级别），方便排查
    logger.info(`[CONNECT] ${hostname}:${port} (来源: ${clientAddr})`);

    if (this.router.shouldInterceptOrSmart(hostname)) {
      if (this.router.shouldIntercept(hostname)) {
        logger.info(`🔒 拦截 HTTPS 连接: ${hostname}:${port}`);
      } else {
        logger.info(`🔍 智能检测 ${hostname}:${port}（将解密后判断是否为 LLM 请求）`);
      }
      this.handleInterceptedConnect(req, clientSocket, head, hostname, port);
    } else {
      logger.info(`➡️  隧道透传: ${hostname}:${port}`);
      this.passthroughConnect(req, clientSocket, head, hostname, port);
    }
  }

  /**
   * 处理拦截的 HTTPS 连接 — MITM（中间人）
   * 
   * 正确的流程：
   *   1. 先回复 200 Connection Established（明文）
   *   2. 然后与客户端进行 TLS 握手（服务端模式）
   *   3. 从解密后的 TLS 流中读取 HTTP 请求
   *   4. 转发到目标 API 并返回响应
   */
  handleInterceptedConnect(req, clientSocket, head, hostname, port) {
    try {
      const certData = generateCertForDomain(this.rootCA, hostname);
      logger.info(`[MITM] 准备拦截 ${hostname}，生成的证书已缓存`);

      // 步骤1: 先发送 200 建立 CONNECT 隧道（必须在 TLS 握手之前）
      const wrote = clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      // 步骤2: 发送完成后，将客户端 Socket 升级为 TLS（服务端模式）
      // 注意：isServer: true 是关键，否则 TLSSocket 会以客户端模式连接
      const tlsOptions = {
        key: certData.key,
        cert: certData.cert,
        isServer: true,
        // ★ 添加 ALPN 支持：某些客户端（如 Copilot 插件通过 OkHttp）需要 ALPN 协商
        // 同时支持 HTTP/1.1 和 HTTP/2，如果客户端用 h2，我们的 HTTP 解析可能会失败，
        // 但至少 TLS 握手能完成，我们可以根据实际情况再适配
        ALPNProtocols: ['http/1.1', 'h2'],
        SNICallback: (servername, cb) => {
          try {
            const snCert = generateCertForDomain(this.rootCA, servername);
            cb(null, tls.createSecureContext({
              key: snCert.key,
              cert: snCert.cert,
              ALPNProtocols: ['http/1.1', 'h2'],
            }));
          } catch (err) {
            cb(err);
          }
        },
      };

      const tlsSocket = new tls.TLSSocket(clientSocket, tlsOptions);

      tlsSocket.on('secure', () => {
        const cipher = tlsSocket.getCipher();
        const alpn = tlsSocket.alpnProtocol || 'none';
        logger.info(`[MITM] TLS 握手成功: ${hostname} (加密: ${cipher?.name || 'unknown'}, ALPN: ${alpn})`);

        // 如果有 head 数据（可能包含 ClientHello 之后的早期数据），喂给 TLS socket
        if (head && head.length > 0) {
          logger.info(`[MITM] 写入 ${head.length} 字节的 head 数据到 TLS socket`);
          tlsSocket.push(head);
        }

        this.handleInterceptedHTTPS(tlsSocket, hostname);
      });

      tlsSocket.on('error', (err) => {
        // ECONNRESET 是客户端正常关闭连接后的预期行为，无需恐慌
        if (err.code === 'ECONNRESET' || err.code === 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA') {
          logger.debug(`[MITM TLS] ${hostname}: ${err.message} (预期行为)`);
        } else {
          logger.error(`[MITM TLS 错误] ${hostname}: ${err.message} (${err.code})`);
          clientSocket.destroy();
        }
      });

    } catch (err) {
      logger.error(`[MITM 设置失败] ${hostname}: ${err.message}`);
      try { clientSocket.write('HTTP/1.1 502 Proxy Error\r\n\r\n'); } catch(e) {}
      clientSocket.destroy();
    }
  }

  /**
   * 处理已建立 TLS 连接的 HTTPS 请求
   */
  handleInterceptedHTTPS(tlsSocket, hostname) {
    let buffer = '';

    const processRequest = () => {
      // 找到 HTTP 头部结束标记
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        logger.info(`[MITM] ${hostname} 等待更多数据... (当前缓存 ${buffer.length} 字节)`);
        return;
      }

      const headerPart = buffer.substring(0, headerEnd);
      let body = buffer.substring(headerEnd + 4);

      const lines = headerPart.split('\r\n');
      if (lines.length === 0) return;

      const requestParts = lines[0].split(' ');
      if (requestParts.length < 2) return;

      const method = requestParts[0];
      const pathname = requestParts[1];

      // 解析请求头
      const headers = {};
      for (let i = 1; i < lines.length; i++) {
        const colonIdx = lines[i].indexOf(':');
        if (colonIdx > 0) {
          const key = lines[i].substring(0, colonIdx).trim().toLowerCase();
          const value = lines[i].substring(colonIdx + 1).trim();
          headers[key] = value;
        }
      }

      // ★ 关键修复：等待完整 body 接收完毕
      // Content-Length 可能不存在（如 GET 请求）或为 0
      const contentLength = parseInt(headers['content-length'], 10);
      if (!isNaN(contentLength) && contentLength > 0 && Buffer.byteLength(body, 'utf-8') < contentLength) {
        logger.info(`[MITM] ${hostname} 等待完整 body... ` +
          `(当前 ${Buffer.byteLength(body, 'utf-8')}/${contentLength} 字节)`);
        // 不清除 buffer，保留已接收的数据等待下一个 chunk
        return;
      }

      // 清除已处理的数据（包括 headers 和完整的 body）
      buffer = '';

      logger.info('');
      logger.info(`=== [MITM] ${method} https://${hostname}${pathname} ===`);

      // 打印关键请求头
      if (headers['content-type']) logger.info(`  Content-Type: ${headers['content-type']}`);
      if (headers['content-length']) logger.info(`  Content-Length: ${headers['content-length']}`);
      if (headers['authorization']) logger.info(`  Authorization: Bearer ***${headers['authorization'].slice(-20)}`);

      this._handleRequest(tlsSocket, method, hostname, pathname, headers, body);
    };

    // 收集数据 — 每次收到 TLS 解密后的数据就尝试解析
    tlsSocket.on('data', (data) => {
      const chunk = data.toString('utf-8');
      logger.info(`[MITM] ${hostname} 收到 ${data.length} 字节数据`);
      buffer += chunk;
      processRequest();
    });

    tlsSocket.on('end', () => {
      logger.info(`[MITM] ${hostname} 连接关闭`);
    });

    tlsSocket.on('error', (err) => {
      if (err.code === 'ECONNRESET') {
        logger.debug(`[MITM 数据流] ${hostname}: ${err.message} (预期行为)`);
      } else {
        logger.info(`[MITM 数据流] ${hostname}: ${err.message} (${err.code})`);
      }
    });
  }

  /**
   * 处理单个 HTTP 请求并回复
   * 对于智能拦截域名，先检测是否为 LLM 请求，否则透传到原始服务器
   */
  async _handleRequest(tlsSocket, method, hostname, pathname, headers, body) {
    // ★ 智能拦截域名：检测是否为 LLM 请求
    if (this.router.isSmartInterceptDomain(hostname)) {
      if (RequestRouter.isLLMRequest(method, pathname, headers, body)) {
        logger.info(`🎯 [智能拦截] 检测到大模型请求: ${method} ${pathname}`);
        await this._routeAndRespond(tlsSocket, method, hostname, pathname, headers, body);
      } else {
        logger.info(`➡️  [智能透传] 非 LLM 请求，转发到原始服务器: ${method} ${pathname}`);
        this.forwardToOriginalServer(tlsSocket, method, hostname, pathname, headers, body);
      }
      return;
    }

    // ★ 直接拦截域名：始终通过适配器处理
    await this._routeAndRespond(tlsSocket, method, hostname, pathname, headers, body);
  }

  /**
   * 通过适配器处理请求并返回响应
   */
  async _routeAndRespond(tlsSocket, method, hostname, pathname, headers, body) {
    try {
      const response = await this.router.routeIntercepted(
        method, hostname, pathname, headers, body
      );

      // ★ Token 用量追踪：从请求和响应中提取 usage 并记录
      try {
        if (TokenTracker.isLLMInferencePath(pathname) && response.statusCode === 200) {
          const usage = TokenTracker.extractUsage(body, response.body, response.headers);
          if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
            const model = TokenTracker.extractModel(body) || 'unknown';
            // 查找目标模型名（从响应 body 中获取 model，或从请求中推断）
            let targetModel = '';
            try {
              const respObj = JSON.parse(response.body);
              targetModel = respObj.model || '';
            } catch (e) { /* ignore */ }

            this.tokenTracker.record({
              model,
              targetModel,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              cacheHitTokens: usage.cacheHitTokens || 0,
              host: hostname,
            });
            var cacheInfo = usage.cacheHitTokens ? ' (缓存命中 ' + usage.cacheHitTokens + ')' : '';
            logger.info('  \uD83D\uDCCA Token 用量: prompt=' + usage.promptTokens + ' + completion=' + usage.completionTokens + ' = ' + usage.totalTokens + cacheInfo + ' (' + model + ')');
          }
        }
      } catch (e) {
        logger.debug(`  [TokenTracker] 记录失败: ${e.message}`);
      }

      // 构建 HTTP 响应
      let responseHeaders = `HTTP/1.1 ${response.statusCode} ${this.getStatusText(response.statusCode)}\r\n`;
      for (const [key, value] of Object.entries(response.headers || {})) {
        responseHeaders += `${key}: ${value}\r\n`;
      }
      responseHeaders += '\r\n';

      logger.info(`  → 响应: ${response.statusCode} (${(response.body || '').length} 字节)`);

      tlsSocket.write(responseHeaders);
      if (response.body) {
        tlsSocket.write(response.body);
      }
      tlsSocket.end();

    } catch (err) {
      logger.error(`[MITM 处理失败] ${hostname}${pathname}: ${err.message}`);
      try {
        const errorResp = 'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n';
        tlsSocket.write(errorResp);
        tlsSocket.end();
      } catch (e) {
        // socket 可能已关闭
      }
    }
  }

  /**
   * 将请求转发到原始服务器（用于智能拦截中的非 LLM 请求）
   * 建立到原始服务器的 HTTPS 连接，双向管道传输数据
   */
  forwardToOriginalServer(tlsSocket, method, hostname, pathname, headers, body) {
    try {
      const options = {
        hostname: hostname,
        port: 443,
        path: pathname,
        method: method,
        headers: { ...headers },
        rejectUnauthorized: false,
        timeout: 60000,
      };

      // 删除逐跳头
      delete options.headers['proxy-connection'];
      delete options.headers['proxy-authorization'];
      delete options.headers['proxy-authenticate'];
      delete options.headers['connection'];
      delete options.headers['keep-alive'];
      delete options.headers['te'];
      delete options.headers['trailer'];
      delete options.headers['upgrade'];

      const proxyReq = https.request(options, (proxyRes) => {
        // 构建状态行
        const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage || 'OK'}`;
        
        // 构建响应头 — 排除逐跳头，保留所有其他头
        const hopByHop = ['proxy-connection', 'proxy-authenticate', 'proxy-authorization',
                          'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer',
                          'upgrade'];
        let headerLines = [statusLine];
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!hopByHop.includes(key.toLowerCase())) {
            headerLines.push(`${key}: ${value}`);
          }
        }
        headerLines.push('x-proxy: ModelProxy (passthrough)');
        headerLines.push('');
        const rawResponse = headerLines.join('\r\n');

        logger.info(`  → 原始服务器响应: ${proxyRes.statusCode} (透传模式)`);

        // 发送响应头
        tlsSocket.write(rawResponse);
        
        // 管道传输响应体
        proxyRes.pipe(tlsSocket, { end: true });
      });

      proxyReq.on('error', (err) => {
        logger.error(`[原始服务器转发失败] ${hostname}:${pathname} - ${err.message}`);
        try {
          const errResp = 'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n';
          tlsSocket.write(errResp);
          tlsSocket.end();
        } catch (e) { /* socket 可能已关闭 */ }
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        logger.error(`[原始服务器转发超时] ${hostname}:${pathname}`);
        try {
          const errResp = 'HTTP/1.1 504 Gateway Timeout\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n';
          tlsSocket.write(errResp);
          tlsSocket.end();
        } catch (e) { /* socket 可能已关闭 */ }
      });

      if (body) {
        proxyReq.write(body);
      }
      proxyReq.end();

    } catch (err) {
      logger.error(`[原始服务器转发异常] ${hostname}:${pathname} - ${err.message}`);
      try {
        const errResp = 'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n';
        tlsSocket.write(errResp);
        tlsSocket.end();
      } catch (e) { /* socket 可能已关闭 */ }
    }
  }

  /**
   * 状态页面
   */
  serveStatusPage(res) {
    const uptime = Math.floor((new Date() - this.startTime) / 1000);
    const rows = this.recentRequests.map(r =>
      `<tr><td>${r.time}</td><td>${r.type}</td><td>${r.method || ''}</td><td>${r.host || r.url || ''}</td><td>${r.status || ''}</td></tr>`
    ).join('\n');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>ModelProxy 状态</title>
<style>
body { font-family: sans-serif; max-width: 900px; margin: 20px auto; padding: 0 20px; background: #f5f5f5; }
h1 { color: #333; }
.card { background: #fff; border-radius: 8px; padding: 16px; margin: 12px 0; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
.status-ok { color: #0a0; font-weight: bold; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th,td { text-align:left; padding:6px 8px; border-bottom:1px solid #eee; }
th { background:#f8f8f8; font-weight:600; }
code { background:#eee; padding:2px 6px; border-radius:3px; font-size:13px; }
.footer { color:#999; font-size:12px; margin-top:20px; }
</style></head>
<body>
<h1>🔌 ModelProxy</h1>
<div class="card">
  <p><span class="status-ok">● 运行中</span> | 已运行 ${uptime} 秒</p>
  <p>📋 日志文件: <code>${logger.getLogFilePath()}</code></p>
</div>
<div class="card">
  <h3>配置</h3>
  <table>
    <tr><td>监听地址</td><td><code>${this.config.proxy.host}:${this.config.proxy.port}</code></td></tr>
    <tr><td>目标 API</td><td><code>${this.config.target.base_url}</code></td></tr>
    <tr><td>默认模型</td><td><code>${this.config.target.model_mapping?.default || '未配置'}</code></td></tr>
    <tr><td>拦截域名</td><td>${this.router.getInterceptDomains().map(d => `<code>${d}</code>`).join(' ')}</td></tr>
    <tr><td>智能拦截</td><td>${this.router.getSmartInterceptDomains().map(d => `<code>${d}</code>`).join(' ')}<br><small style="color:#888">仅拦截 LLM 推理请求，其余透传</small></td></tr>
    <tr><td>CA 证书</td><td><code>${require('./cert-manager').getRootCACrtPath()}</code></td></tr>
  </table>
</div>
<div class="card">
  <h3>最近请求 (${this.recentRequests.length})</h3>
  <table>
    <thead><tr><th>时间</th><th>类型</th><th>方法</th><th>目标</th><th>状态</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">暂无请求记录 — 代理正在等待请求...</td></tr>'}</tbody>
  </table>
</div>
<div class="card">
  <h3>快速验证</h3>
  <p>1. 打开浏览器访问 <a href="/_modelproxy/health" target="_blank">/_modelproxy/health</a></p>
  <p>2. 或用命令行: <code>curl -x http://127.0.0.1:${this.config.proxy.port} https://api.openai.com/v1/models</code></p>
  <p>3. 查看日志文件: <code>type proxy.log</code> 或 <code>Get-Content proxy.log -Tail 20</code></p>
</div>
<div class="footer">ModelProxy v1.0.4 | ${new Date().toISOString()}</div>
</body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * 管理后台页面 — 在线配置编辑 UI
   */
  serveAdminPage(res) {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ModelProxy 管理面板</title>
<style>
:root { --bg: #0f1419; --card: #1a1f2e; --border: #2a3040; --text: #e1e4e8;
  --text-secondary: #8b949e; --accent: #58a6ff; --success: #3fb950;
  --warning: #d29922; --danger: #f85149; --input-bg: #0d1117; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5; }
.container { max-width: 1100px; margin: 0 auto; padding: 20px; }
.header { display: flex; align-items: center; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
.header h1 { font-size: 20px; font-weight: 600; }
.header .badge { background: var(--success); color: #000; padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
.tab { padding: 10px 20px; cursor: pointer; border: none; background: none; color: var(--text-secondary); font-size: 14px; border-bottom: 2px solid transparent; transition: all .2s; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.panel { display: none; }
.panel.active { display: block; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
.card h3 { font-size: 14px; font-weight: 600; margin-bottom: 16px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: .5px; }
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; }
.form-group input, .form-group select, .form-group textarea { width: 100%; padding: 8px 12px; background: var(--input-bg);
  border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 14px; font-family: 'SF Mono', 'Cascadia Code', monospace; }
.form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: var(--accent); }
.form-group textarea { min-height: 80px; resize: vertical; font-size: 12px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.btn { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all .2s; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { opacity: .85; }
.btn-success { background: var(--success); color: #000; }
.btn-success:hover { opacity: .85; }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover { opacity: .85; }
.btn-sm { padding: 4px 12px; font-size: 12px; }
.btn-group { display: flex; gap: 8px; margin-top: 20px; }
.mapping-row { display: grid; grid-template-columns: 1fr 1fr 40px; gap: 8px; align-items: center; margin-bottom: 8px; }
.mapping-row input { padding: 6px 10px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 13px; font-family: 'SF Mono', monospace; }
.mapping-row input:focus { outline: none; border-color: var(--accent); }
.mapping-row .remove-btn { background: none; border: none; color: var(--danger); cursor: pointer; font-size: 18px; padding: 4px; line-height: 1; }
.mapping-row .remove-btn:hover { opacity: .7; }
.add-btn { background: none; border: 1px dashed var(--border); color: var(--accent); padding: 6px; border-radius: 4px; cursor: pointer; font-size: 13px; width: 100%; margin-top: 4px; }
.add-btn:hover { border-color: var(--accent); background: rgba(88,166,255,.05); }
.toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; font-size: 14px; z-index: 999;
  transform: translateX(120%); transition: transform .3s ease; }
.toast.show { transform: translateX(0); }
.toast.success { background: var(--success); color: #000; }
.toast.error { background: var(--danger); color: #fff; }
.domain-list { display: flex; flex-wrap: wrap; gap: 8px; }
.domain-tag { display: inline-flex; align-items: center; gap: 6px; background: var(--input-bg); border: 1px solid var(--border);
  padding: 4px 10px; border-radius: 4px; font-size: 12px; font-family: 'SF Mono', monospace; }
.domain-tag .del { cursor: pointer; color: var(--text-secondary); font-size: 14px; }
.domain-tag .del:hover { color: var(--danger); }
.add-domain { display: flex; gap: 8px; margin-top: 8px; }
.add-domain input { flex: 1; padding: 6px 10px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 13px; }
.add-domain input:focus { outline: none; border-color: var(--accent); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.status-dot.ok { background: var(--success); }
.status-dot.err { background: var(--danger); }
.footer-info { font-size: 12px; color: var(--text-secondary); text-align: center; padding: 20px 0; }
/* Token 统计表格对齐 */
.stats-table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
.stats-table th, .stats-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); word-wrap: break-word; overflow-wrap: break-word; }
.stats-table th { background: var(--card); font-weight: 600; color: var(--text-secondary); font-size: 12px; text-transform: uppercase; letter-spacing: .3px; position: sticky; top: 0; z-index: 1; }
.stats-table td code { font-size: 12px; background: var(--input-bg); padding: 1px 6px; border-radius: 3px; }
.stats-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.stats-table .bar-cell { width: 25%; min-width: 100px; }
.checkbox-group { display: flex; align-items: center; gap: 8px; }
.checkbox-group input[type="checkbox"] { width: auto; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🔌 ModelProxy 管理面板</h1>
    <span class="badge" id="statusBadge">运行中</span>
    <span style="margin-left:auto;font-size:12px;color:var(--text-secondary)" id="uptimeInfo"></span>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="target">目标供应商</button>
    <button class="tab" data-tab="models">模型定义</button>
    <button class="tab" data-tab="domains">拦截域名</button>
    <button class="tab" data-tab="tokens">Token 统计</button>
    <button class="tab" data-tab="advanced">高级</button>
  </div>

  <!-- 目标供应商 -->
  <div class="panel active" id="panel-target">
    <div class="card">
      <h3>供应商配置</h3>
      <div class="form-group">
        <label>供应商类型</label>
        <select id="targetType">
          <option value="openai-compatible">OpenAI 兼容</option>
          <option value="anthropic-compatible">Anthropic 兼容</option>
        </select>
      </div>
      <div class="form-group">
        <label>API 基础地址 (Base URL)</label>
        <input type="url" id="targetBaseUrl" placeholder="https://api.deepseek.com">
      </div>
      <div class="form-group">
        <label>API Key（可选，留空则使用请求中的 Authorization 头）</label>
        <input type="password" id="targetApiKey" placeholder="sk-...">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>监听主机</label>
          <input type="text" id="proxyHost" placeholder="127.0.0.1">
        </div>
        <div class="form-group">
          <label>监听端口</label>
          <input type="number" id="proxyPort" placeholder="8080">
        </div>
      </div>
      <div class="form-group">
        <label>日志级别</label>
        <select id="logLevel">
          <option value="debug">debug</option>
          <option value="info" selected>info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
      </div>
      <p style="font-size:12px;color:var(--text-secondary);margin-top:-8px">上下文窗口在下方「模型定义」中按模型配置</p>
    </div>
  </div>

  <!-- 模型定义（合并映射、能力、思考、视觉） -->
  <div class="panel" id="panel-models">
    <div class="card">
      <h3>模型定义</h3>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">定义每个模型的完整能力（目标模型、上下文窗口、思考、视觉等）。模型ID是 Copilot 中显示的模型名。</p>
      <div id="modelsList"></div>
      <button class="add-btn" onclick="addModel()">+ 添加模型</button>
    </div>
  </div>

  <!-- 拦截域名 -->
  <div class="panel" id="panel-domains">
    <div class="card">
      <h3>直接拦截的域名</h3>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">这些域名的所有 HTTPS 请求都会被拦截并转发</p>
      <div class="domain-list" id="interceptDomains"></div>
      <div class="add-domain">
        <input type="text" id="newInterceptDomain" placeholder="api.openai.com" onkeydown="if(event.key==='Enter')addInterceptDomain()">
        <button class="btn btn-primary btn-sm" onclick="addInterceptDomain()">添加</button>
      </div>
    </div>
    <div class="card">
      <h3>智能拦截域名</h3>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">仅拦截 LLM 推理请求（chat/completions），其余请求透传</p>
      <div class="domain-list" id="smartInterceptDomains"></div>
      <div class="add-domain">
        <input type="text" id="newSmartDomain" placeholder="openrouter.ai" onkeydown="if(event.key==='Enter')addSmartDomain()">
        <button class="btn btn-primary btn-sm" onclick="addSmartDomain()">添加</button>
      </div>
    </div>
  </div>

  <!-- 高级 -->
  <div class="panel" id="panel-advanced">
    <div class="card">
      <h3>配置文件切换</h3>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">选择不同的配置文件可快速切换供应商。当前配置通过顶部「保存配置」按钮写入当前选中的文件。</p>
      <div class="form-row" style="align-items:center">
        <div class="form-group" style="flex:1">
          <select id="configSelector" style="width:100%;padding:8px 12px;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px"></select>
        </div>
        <button class="btn btn-primary" onclick="switchConfig()" style="white-space:nowrap;margin-top:14px">🔄 切换</button>
        <button class="btn btn-sm" onclick="refreshConfigList()" style="white-space:nowrap;margin-top:14px;background:var(--input-bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;cursor:pointer;font-size:13px">🔄 刷新列表</button>
      </div>
    </div>
    <div class="card">
      <h3>操作</h3>
      <div class="btn-group">
        <button class="btn btn-danger" onclick="reloadConfig()">🔄 从文件重新加载</button>
      </div>
    </div>
    <div class="card">
      <h3>当前配置预览 (JSON)</h3>
      <pre id="configPreview" style="background:var(--input-bg);border:1px solid var(--border);border-radius:4px;padding:12px;font-size:12px;overflow:auto;max-height:400px;white-space:pre-wrap;word-break:break-all;"></pre>
    </div>
  </div>

  <!-- Token 统计 -->
  <div class="panel" id="panel-tokens">
    <div class="card">
      <h3>用量概览</h3>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px" id="statsSummary">
        <div class="stat-card" data-period="today" style="background:var(--input-bg);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:12px;color:var(--text-secondary)">今日</div>
          <div class="stat-value" style="font-size:22px;font-weight:700;margin:6px 0">-</div>
          <div style="font-size:11px;color:var(--text-secondary)"><span class="stat-prompt">-</span> prompt · <span class="stat-completion">-</span> completion<span class="stat-cache" style="display:none"> · <span class="stat-cache-val">-</span> \u7F13\u5B58</span></div>
        </div>
        <div class="stat-card" data-period="week" style="background:var(--input-bg);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:12px;color:var(--text-secondary)">本周</div>
          <div class="stat-value" style="font-size:22px;font-weight:700;margin:6px 0">-</div>
          <div style="font-size:11px;color:var(--text-secondary)"><span class="stat-prompt">-</span> prompt · <span class="stat-completion">-</span> completion<span class="stat-cache" style="display:none"> · <span class="stat-cache-val">-</span> \u7F13\u5B58</span></div>
        </div>
        <div class="stat-card" data-period="month" style="background:var(--input-bg);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:12px;color:var(--text-secondary)">本月</div>
          <div class="stat-value" style="font-size:22px;font-weight:700;margin:6px 0">-</div>
          <div style="font-size:11px;color:var(--text-secondary)"><span class="stat-prompt">-</span> prompt · <span class="stat-completion">-</span> completion<span class="stat-cache" style="display:none"> · <span class="stat-cache-val">-</span> \u7F13\u5B58</span></div>
        </div>
        <div class="stat-card" data-period="all" style="background:var(--input-bg);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:12px;color:var(--text-secondary)">全部</div>
          <div class="stat-value" style="font-size:22px;font-weight:700;margin:6px 0">-</div>
          <div style="font-size:11px;color:var(--text-secondary)"><span class="stat-prompt">-</span> prompt · <span class="stat-completion">-</span> completion<span class="stat-cache" style="display:none"> · <span class="stat-cache-val">-</span> \u7F13\u5B58</span></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>按模型统计（全部）</h3>
      <div style="overflow-x:auto">
        <table class="stats-table" id="modelStatsTable">
          <colgroup><col style="width:22%"><col style="width:10%"><col style="width:18%"><col style="width:18%"><col style="width:12%"><col style="width:20%"></colgroup>
          <thead><tr><th>\u6A21\u578B</th><th class="num">\u8BF7\u6C42\u6570</th><th class="num">Prompt</th><th class="num">Completion</th><th class="num">\u7F13\u5B58\u547D\u4E2D</th><th class="num">Total</th></tr></thead>
          <tbody id="modelStatsBody"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>\u6BCF\u65E5\u660E\u7EC6</h3>
      <div style="overflow-x:auto">
        <table class="stats-table" id="dailyStatsTable">
          <colgroup><col style="width:14%"><col style="width:10%"><col style="width:16%"><col style="width:16%"><col style="width:12%"><col style="width:12%"><col style="width:20%"></colgroup>
          <thead><tr><th>\u65E5\u671F</th><th class="num">\u8BF7\u6C42\u6570</th><th class="num">Prompt</th><th class="num">Completion</th><th class="num">\u7F13\u5B58\u547D\u4E2D</th><th class="num">Total</th><th>\u8D8B\u52BF</th></tr></thead>
          <tbody id="dailyStatsBody"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>\u6700\u8FD1\u8BF7\u6C42 <span style="font-weight:400;font-size:12px;color:var(--text-secondary)">\uFF08\u6700\u591A 100 \u6761\uFF09</span></h3>
      <div style="overflow-x:auto">
        <table class="stats-table" id="recentStatsTable">
          <colgroup><col style="width:10%"><col style="width:18%"><col style="width:18%"><col style="width:12%"><col style="width:12%"><col style="width:10%"><col style="width:10%"><col style="width:10%"></colgroup>
          <thead><tr><th>\u65F6\u95F4</th><th>\u6A21\u578B</th><th>\u76EE\u6807\u6A21\u578B</th><th class="num">Prompt</th><th class="num">Completion</th><th class="num">\u7F13\u5B58</th><th class="num">Total</th><th>\u6765\u6E90</th></tr></thead>
          <tbody id="recentStatsBody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="btn-group" style="justify-content:center;padding:8px 0 24px">
    <button class="btn btn-success" onclick="saveConfig()" style="padding:12px 40px;font-size:16px">💾 保存配置</button>
  </div>

  <div class="footer-info">ModelProxy v1.0.4 — 修改配置后点击保存，配置立即生效，无需重启代理</div>
</div>

<div class="toast" id="toast"></div>

<script>
let config = {};

async function loadConfig() {
  try {
    const res = await fetch('/_modelproxy/config');
    config = await res.json();
    renderConfig();
    refreshConfigList();
  } catch(e) {
    showToast('加载配置失败: ' + e.message, 'error');
  }
}

function renderConfig() {
  const t = config.target || {};
  const p = config.proxy || {};

  // 目标供应商
  document.getElementById('targetType').value = t.type || 'openai-compatible';
  document.getElementById('targetBaseUrl').value = t.base_url || '';
  document.getElementById('targetApiKey').value = t.api_key || '';
  document.getElementById('proxyHost').value = p.host || '127.0.0.1';
  document.getElementById('proxyPort').value = p.port || 8080;
  document.getElementById('logLevel').value = config.log_level || 'info';

  // ★ 模型定义（合并映射+思考+视觉等所有能力）
  renderModels(t.models || {});

  // 拦截域名
  renderDomains('interceptDomains', config.intercept_domains, 'removeInterceptDomain');
  renderDomains('smartInterceptDomains', config.smart_intercept_domains, 'removeSmartDomain');

  // 预览
  document.getElementById('configPreview').textContent = JSON.stringify(config, null, 2);
}

function renderModels(models) {
  const list = document.getElementById('modelsList');
  list.innerHTML = '';
  
  // 表头
  const header = document.createElement('div');
  header.className = 'mapping-row';
  header.style.gridTemplateColumns = '1fr 1fr 120px 100px 70px 80px 70px 60px 40px';
  header.style.fontSize = '11px';
  header.style.color = 'var(--text-secondary)';
  header.style.marginBottom = '4px';
  header.innerHTML =
    '<span>模型ID</span>' +
    '<span>目标模型</span>' +
    '<span>显示名称</span>' +
    '<span>上下文窗口</span>' +
    '<span>最大输出</span>' +
    '<span>思考</span>' +
    '<span>思考级别</span>' +
    '<span>视觉</span>' +
    '<span></span>';
  list.appendChild(header);
  
  for (const [id, cfg] of Object.entries(models || {})) {
    addModelRow(id, cfg);
  }
}

function addModelRow(id, cfg) {
  const list = document.getElementById('modelsList');
  const div = document.createElement('div');
  div.className = 'mapping-row';
  div.style.gridTemplateColumns = '1fr 1fr 120px 100px 70px 80px 70px 60px 40px';
  cfg = cfg || {};
  const effort = cfg.reasoning_effort || 'high';
  div.innerHTML =
    '<input type="text" class="model-id" value="' + esc(id) + '" placeholder="模型ID" style="min-width:80px">' +
    '<input type="text" class="model-target" value="' + esc(cfg.target_model || '') + '" placeholder="目标模型" style="min-width:80px">' +
    '<input type="text" class="model-name" value="' + esc(cfg.name || '') + '" placeholder="显示名称" style="min-width:80px">' +
    '<input type="number" class="model-ctx" value="' + (cfg.context_window || '1048576') + '" placeholder="上下文" style="width:90px">' +
    '<input type="number" class="model-output" value="' + (cfg.max_output_tokens || '64000') + '" placeholder="输出" style="width:60px">' +
    '<label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" class="model-thinking" ' + (cfg.thinking ? 'checked' : '') + '> 思考</label>' +
    '<select class="model-effort" style="padding:4px 6px;background:var(--input-bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px">' +
    '<option value="high"' + (effort === 'high' ? ' selected' : '') + '>high</option>' +
    '<option value="max"' + (effort === 'max' ? ' selected' : '') + '>max</option></select>' +
    '<label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" class="model-vision" ' + (cfg.vision ? 'checked' : '') + '> 视觉</label>' +
    '<button class="remove-btn" onclick="this.parentElement.remove()">✕</button>';
  list.appendChild(div);
}

function addModel() {
  addModelRow('', {});
}

function renderDomains(id, domains, removeFn) {
  const container = document.getElementById(id);
  if (!container) return;
  const list = Array.isArray(domains) ? domains : [];
  container.innerHTML = list.map(d =>
    '<span class="domain-tag">' + esc(d) + ' <span class="del" onclick="' + removeFn + "('" + esc(d) + "')" + '">✕</span></span>'
  ).join('');
}

function addInterceptDomain() {
  const input = document.getElementById('newInterceptDomain');
  const val = input.value.trim();
  if (!val) return;
  if (!config.intercept_domains) config.intercept_domains = [];
  if (!config.intercept_domains.includes(val)) {
    config.intercept_domains.push(val);
    renderDomains('interceptDomains', config.intercept_domains, 'removeInterceptDomain');
  }
  input.value = '';
}

function removeInterceptDomain(domain) {
  config.intercept_domains = config.intercept_domains.filter(d => d !== domain);
  renderDomains('interceptDomains', config.intercept_domains, 'removeInterceptDomain');
}

function addSmartDomain() {
  const input = document.getElementById('newSmartDomain');
  const val = input.value.trim();
  if (!val) return;
  if (!config.smart_intercept_domains) config.smart_intercept_domains = [];
  if (!config.smart_intercept_domains.includes(val)) {
    config.smart_intercept_domains.push(val);
    renderDomains('smartInterceptDomains', config.smart_intercept_domains, 'removeSmartDomain');
  }
  input.value = '';
}

function removeSmartDomain(domain) {
  config.smart_intercept_domains = config.smart_intercept_domains.filter(d => d !== domain);
  renderDomains('smartInterceptDomains', config.smart_intercept_domains, 'removeSmartDomain');
}

function collectConfig() {
  const target = config.target || {};
  target.type = document.getElementById('targetType').value;
  target.base_url = document.getElementById('targetBaseUrl').value.trim();
  target.api_key = document.getElementById('targetApiKey').value.trim();

  config.proxy = config.proxy || {};
  config.proxy.host = document.getElementById('proxyHost').value.trim() || '127.0.0.1';
  config.proxy.port = parseInt(document.getElementById('proxyPort').value) || 8080;
  config.log_level = document.getElementById('logLevel').value;

  // ★ 模型定义（合并映射、思考、视觉等所有能力）
  const models = {};
  document.querySelectorAll('#modelsList .mapping-row').forEach(row => {
    const id = row.querySelector('.model-id')?.value?.trim();
    const targetModel = row.querySelector('.model-target')?.value?.trim();
    if (!id || !targetModel) return;
    models[id] = {
      target_model: targetModel,
      name: row.querySelector('.model-name')?.value?.trim() || id,
      context_window: parseInt(row.querySelector('.model-ctx')?.value) || 1048576,
      max_output_tokens: parseInt(row.querySelector('.model-output')?.value) || 64000,
      thinking: row.querySelector('.model-thinking')?.checked || false,
      reasoning_effort: row.querySelector('.model-effort')?.value || 'high',
      vision: row.querySelector('.model-vision')?.checked || false,
    };
  });
  target.models = models;

  // 清理旧格式字段
  delete target.model_mapping;
  delete target.thinking;
  delete target.context_window;

  config.target = target;
  return config;
}

async function saveConfig() {
  collectConfig();
  const updates = {};

  // 构建扁平化的更新映射
  updates['target.type'] = config.target.type;
  updates['target.base_url'] = config.target.base_url;
  updates['target.api_key'] = config.target.api_key;
  updates['target.models'] = config.target.models;
  // 清除旧格式字段
  updates['target.model_mapping'] = undefined;
  updates['target.thinking'] = undefined;
  updates['target.context_window'] = undefined;
  updates['proxy.host'] = config.proxy.host;
  updates['proxy.port'] = config.proxy.port;
  updates['log_level'] = config.log_level;
  updates['intercept_domains'] = config.intercept_domains;
  updates['smart_intercept_domains'] = config.smart_intercept_domains;

  try {
    const res = await fetch('/_modelproxy/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const result = await res.json();
    if (result.success) {
      showToast('✅ 配置已保存并生效', 'success');
      // 重新加载以获取最新配置
      await loadConfig();
    } else {
      showToast('❌ ' + result.message, 'error');
    }
  } catch(e) {
    showToast('❌ 保存失败: ' + e.message, 'error');
  }
}

async function reloadConfig() {
  try {
    const res = await fetch('/_modelproxy/reload', { method: 'POST' });
    const result = await res.json();
    if (result.success) {
      showToast('✅ 配置已从文件重新加载', 'success');
      await loadConfig();
    }
  } catch(e) {
    showToast('❌ 重载失败: ' + e.message, 'error');
  }
}

async function refreshConfigList() {
  try {
    const res = await fetch('/_modelproxy/configs');
    const data = await res.json();
    const sel = document.getElementById('configSelector');
    sel.innerHTML = '';
    for (const cfg of (data.configs || [])) {
      const opt = document.createElement('option');
      opt.value = cfg.name;
      opt.textContent = cfg.file + (cfg.isActive ? ' (当前)' : '');
      if (cfg.isActive) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch(e) {
    showToast('❌ 加载配置列表失败: ' + e.message, 'error');
  }
}

async function switchConfig() {
  const sel = document.getElementById('configSelector');
  const name = sel.value;
  try {
    const res = await fetch('/_modelproxy/switch-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: name === 'default' ? '' : name }),
    });
    const result = await res.json();
    if (result.success) {
      showToast('✅ 已切换到: ' + result.configPath, 'success');
      await loadConfig();
      await refreshConfigList();
    } else {
      showToast('❌ ' + result.message, 'error');
    }
  } catch(e) {
    showToast('❌ 切换失败: ' + e.message, 'error');
  }
}

function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + type + ' show';
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Tab 切换
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    // Token 统计 tab 被点击时加载数据
    if (tab.dataset.tab === 'tokens') {
      loadTokenStats();
    }
  });
});

// Token 统计
async function loadTokenStats() {
  try {
    const res = await fetch('/_modelproxy/stats/tokens');
    const stats = await res.json();
    renderTokenStats(stats);
  } catch(e) {
    showToast('加载 Token 统计失败: ' + e.message, 'error');
  }
}

function formatNumber(n) {
  return (n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function renderTokenStats(stats) {
  // 概览卡片
  var periods = [
    { key: 'today', period: 'today' },
    { key: 'thisWeek', period: 'week' },
    { key: 'thisMonth', period: 'month' },
    { key: 'allTime', period: 'all' },
  ];
  
  for (var i = 0; i < periods.length; i++) {
    var p = periods[i];
    var data = stats[p.key] || {};
    var card = document.querySelector('.stat-card[data-period="' + p.period + '"]');
    if (!card) continue;
    card.querySelector('.stat-value').textContent = formatNumber(data.totalTokens || 0);
    card.querySelector('.stat-prompt').textContent = formatNumber(data.promptTokens || 0);
    card.querySelector('.stat-completion').textContent = formatNumber(data.completionTokens || 0);
    // 缓存命中（有数据才显示）
    var cacheEl = card.querySelector('.stat-cache');
    var cacheVal = card.querySelector('.stat-cache-val');
    if (data.cacheHitTokens) {
      cacheEl.style.display = 'inline';
      cacheVal.textContent = formatNumber(data.cacheHitTokens);
    } else {
      cacheEl.style.display = 'none';
    }
  }

  // 按模型统计（全部） — cols: 模型, 请求数, Prompt, Completion, 缓存命中, Total
  var modelBody = document.getElementById('modelStatsBody');
  var modelEntries = Object.entries(stats.models || {});
  if (modelEntries.length === 0) {
    modelBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-secondary);padding:20px">\u6682\u65E0\u6570\u636E</td></tr>';
  } else {
    modelEntries.sort(function(a, b) { return b[1].totalTokens - a[1].totalTokens; });
    modelBody.innerHTML = modelEntries.map(function(e) {
      var model = e[0], data = e[1];
      var cacheStr = data.cacheHitTokens ? formatNumber(data.cacheHitTokens) : '-';
      return '<tr>'
        + '<td><code>' + esc(model) + '</code></td>'
        + '<td class="num">' + formatNumber(data.requests) + '</td>'
        + '<td class="num">' + formatNumber(data.promptTokens) + '</td>'
        + '<td class="num">' + formatNumber(data.completionTokens) + '</td>'
        + '<td class="num" style="color:var(--warning)">' + cacheStr + '</td>'
        + '<td class="num"><strong>' + formatNumber(data.totalTokens) + '</strong></td>'
        + '</tr>';
    }).join('');
  }

  // 每日明细 — cols: 日期, 请求数, Prompt, Completion, 缓存命中, Total, 趋势
  var dailyBody = document.getElementById('dailyStatsBody');
  var dailyData = stats.daily || [];
  if (dailyData.length === 0) {
    dailyBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary);padding:20px">\u6682\u65E0\u6570\u636E</td></tr>';
  } else {
    var maxDaily = dailyData.slice(0, 30);
    var maxTotal = Math.max.apply(null, maxDaily.map(function(d) { return d.totalTokens; }).concat([1]));
    dailyBody.innerHTML = maxDaily.map(function(day) {
      var pct = ((day.totalTokens / maxTotal) * 100).toFixed(1);
      var barWidth = Math.max(2, pct);
      var cacheStr = day.cacheHitTokens ? formatNumber(day.cacheHitTokens) : '-';
      return '<tr>'
        + '<td>' + esc(day.date) + '</td>'
        + '<td class="num">' + formatNumber(day.requests) + '</td>'
        + '<td class="num">' + formatNumber(day.promptTokens) + '</td>'
        + '<td class="num">' + formatNumber(day.completionTokens) + '</td>'
        + '<td class="num" style="color:var(--warning)">' + cacheStr + '</td>'
        + '<td class="num"><strong>' + formatNumber(day.totalTokens) + '</strong></td>'
        + '<td class="bar-cell"><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:16px;background:var(--border);border-radius:8px;overflow:hidden"><div style="height:100%;width:' + barWidth + '%;background:var(--success);border-radius:8px;transition:width .3s"></div></div><span style="font-size:11px;color:var(--text-secondary);min-width:36px">' + pct + '%</span></div></td>'
        + '</tr>';
    }).join('');
  }

  // 最近请求 — cols: 时间, 模型, 目标模型, Prompt, Completion, 缓存, Total, 来源
  var recentBody = document.getElementById('recentStatsBody');
  var recentData = stats.recentRecords || [];
  if (recentData.length === 0) {
    recentBody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-secondary);padding:20px">\u6682\u65E0\u6570\u636E</td></tr>';
  } else {
    recentBody.innerHTML = recentData.map(function(r) {
      var cacheStr = r.cacheHitTokens ? formatNumber(r.cacheHitTokens) : '-';
      return '<tr>'
        + '<td style="white-space:nowrap">' + (r.timestamp ? r.timestamp.substring(11, 19) : '-') + '</td>'
        + '<td><code>' + esc(r.model || '-') + '</code></td>'
        + '<td><code>' + esc(r.targetModel || '-') + '</code></td>'
        + '<td class="num">' + formatNumber(r.promptTokens) + '</td>'
        + '<td class="num">' + formatNumber(r.completionTokens) + '</td>'
        + '<td class="num" style="color:var(--warning)">' + cacheStr + '</td>'
        + '<td class="num"><strong>' + formatNumber(r.totalTokens) + '</strong></td>'
        + '<td style="font-size:11px;color:var(--text-secondary)">' + esc(r.host || '-') + '</td>'
        + '</tr>';
    }).join('');
  }
}

// 加载配置
loadConfig();
</script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * 普通 CONNECT 隧道透传
   */
  passthroughConnect(req, clientSocket, head, hostname, port) {
    const serverSocket = netConnect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      // ECONNRESET / ECONNREFUSED 对透传隧道来说是正常行为，不污染 error 日志
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        logger.debug(`[隧道] ${hostname}:${port} ${err.code}（预期行为，不影响代理功能）`);
      } else {
        logger.warn(`[隧道] ${hostname}:${port} 连接失败: ${err.message}`);
      }
      try {
        clientSocket.write('HTTP/1.1 502 Proxy Error\r\n\r\n');
      } catch (_) { /* socket 可能已关闭 */ }
      clientSocket.destroy();
    });

    clientSocket.on('error', (err) => {
      // ECONNRESET 是客户端关闭连接后的预期行为，无需记录
      if (err.code !== 'ECONNRESET') {
        logger.warn(`[隧道] 客户端 ${hostname}: ${err.message}`);
      }
    });
  }

  /**
   * 透传 HTTP 请求
   */
  forwardRequest(clientReq, clientRes) {
    const parsedUrl = new URL(clientReq.url, 'http://localhost');
    const hostname = parsedUrl.hostname || clientReq.headers.host;
    
    if (!hostname) {
      clientRes.writeHead(400);
      clientRes.end('Bad Request');
      return;
    }

    const options = {
      hostname: hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: clientReq.method,
      headers: { ...clientReq.headers },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
      logger.error(`[转发失败] ${err.message}`);
      clientRes.writeHead(502);
      clientRes.end('Proxy Error');
    });

    clientReq.pipe(proxyReq);
  }

  getStatusText(code) {
    const map = {
      200: 'OK', 201: 'Created', 204: 'No Content',
      301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
      400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
      404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
      429: 'Too Many Requests',
      500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };
    return map[code] || 'Unknown';
  }
}

/**
 * 简易 net.connect 包装
 */
function netConnect(port, host, callback) {
  const net = require('net');
  const socket = net.connect(port, host, callback);
  return socket;
}

module.exports = ProxyServer;
