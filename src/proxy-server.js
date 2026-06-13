const https = require('https');
const http = require('http');
const { URL } = require('url');
const tls = require('tls');
const logger = require('./logger');
const { getOrCreateRootCA, generateCertForDomain } = require('./cert-manager');
const RequestRouter = require('./router');

class ProxyServer {
  constructor(configManager) {
    this.configManager = configManager;
    this.router = new RequestRouter(configManager);
    this.rootCA = null;
    this.recentRequests = []; // 保存最近的请求记录用于状态页展示
    this.startTime = new Date();
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
      logger.info('  ModelProxy v1.0.0');
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
        version: '1.0.0',
      }));
      logger.info('[健康检查] 代理运行正常');
      return;
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
        SNICallback: (servername, cb) => {
          try {
            const snCert = generateCertForDomain(this.rootCA, servername);
            cb(null, tls.createSecureContext({
              key: snCert.key,
              cert: snCert.cert,
            }));
          } catch (err) {
            cb(err);
          }
        },
      };

      const tlsSocket = new tls.TLSSocket(clientSocket, tlsOptions);

      tlsSocket.on('secure', () => {
        const cipher = tlsSocket.getCipher();
        logger.info(`[MITM] TLS 握手成功: ${hostname} (加密: ${cipher?.name || 'unknown'})`);

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
<div class="footer">ModelProxy v1.0.0 | ${new Date().toISOString()}</div>
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
    <button class="tab" data-tab="mapping">模型映射</button>
    <button class="tab" data-tab="thinking">思考模式</button>
    <button class="tab" data-tab="domains">拦截域名</button>
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
      <div class="form-group">
        <label>默认上下文窗口 (context_window)</label>
        <input type="number" id="contextWindowDefault" placeholder="1048576">
      </div>
    </div>
  </div>

  <!-- 模型映射 -->
  <div class="panel" id="panel-mapping">
    <div class="card">
      <h3>模型名称映射</h3>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">左边是 Copilot 中的模型名，右边是目标供应商的模型名</p>
      <div id="mappingList"></div>
      <button class="add-btn" onclick="addMapping()">+ 添加映射</button>
    </div>
  </div>

  <!-- 思考模式 -->
  <div class="panel" id="panel-thinking">
    <div class="card">
      <h3>思考/推理配置</h3>
      <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">按目标模型名（model_mapping 的值）配置。适用于 DeepSeek V4、OpenAI o1/o3 等</p>
      <div class="checkbox-group" style="margin-bottom:16px">
        <input type="checkbox" id="thinkingGlobalEnabled">
        <label for="thinkingGlobalEnabled">全局启用思考模式（覆盖所有模型）</label>
      </div>
      <div id="thinkingList"></div>
      <button class="add-btn" onclick="addThinking()">+ 添加模型思考配置</button>
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

  <div class="btn-group" style="justify-content:center;padding:8px 0 24px">
    <button class="btn btn-success" onclick="saveConfig()" style="padding:12px 40px;font-size:16px">💾 保存配置</button>
  </div>

  <div class="footer-info">ModelProxy v1.0.0 — 修改配置后点击保存，配置立即生效，无需重启代理</div>
</div>

<div class="toast" id="toast"></div>

<script>
let config = {};

async function loadConfig() {
  try {
    const res = await fetch('/_modelproxy/config');
    config = await res.json();
    renderConfig();
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

  const cw = t.context_window || {};
  document.getElementById('contextWindowDefault').value = cw.default || '';

  // 模型映射
  renderMappings(t.model_mapping || {});

  // 思考模式
  renderThinking(t.thinking || {});

  // 拦截域名
  renderDomains('interceptDomains', config.intercept_domains || [], 'removeInterceptDomain');
  renderDomains('smartInterceptDomains', config.smart_intercept_domains || [], 'removeSmartDomain');

  // 预览
  document.getElementById('configPreview').textContent = JSON.stringify(config, null, 2);
}

function renderMappings(mappings) {
  const list = document.getElementById('mappingList');
  list.innerHTML = '';
  for (const [source, target] of Object.entries(mappings)) {
    if (source === 'default') continue;
    addMappingRow(source, target);
  }
}

function addMappingRow(source, target) {
  const list = document.getElementById('mappingList');
  const div = document.createElement('div');
  div.className = 'mapping-row';
  div.innerHTML = '<input type="text" class="map-source" value="' + esc(source) + '" placeholder="Copilot 模型名">' +
    '<input type="text" class="map-target" value="' + esc(target) + '" placeholder="目标模型名">' +
    '<button class="remove-btn" onclick="this.parentElement.remove()">✕</button>';
  list.appendChild(div);
}

function addMapping() {
  addMappingRow('', '');
}

function renderThinking(thinking) {
  // 检查是否为统一格式（顶层有 enabled）
  if (thinking.enabled !== undefined) {
    document.getElementById('thinkingGlobalEnabled').checked = thinking.enabled;
  } else {
    document.getElementById('thinkingGlobalEnabled').checked = false;
  }

  const list = document.getElementById('thinkingList');
  list.innerHTML = '';
  for (const [model, tcfg] of Object.entries(thinking)) {
    if (model === 'enabled' || model === 'default') continue;
    addThinkingRow(model, tcfg.enabled, tcfg.effort);
  }
}

function addThinkingRow(model, enabled, effort) {
  const list = document.getElementById('thinkingList');
  const div = document.createElement('div');
  div.className = 'mapping-row';
  div.style.gridTemplateColumns = '1fr 80px 100px 40px';
  div.innerHTML = '<input type="text" class="think-model" value="' + esc(model || '') + '" placeholder="目标模型名">' +
    '<select class="think-enabled" style="padding:6px 10px;background:var(--input-bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px">' +
    '<option value="true"' + (enabled ? ' selected' : '') + '>开启</option>' +
    '<option value="false"' + (!enabled ? ' selected' : '') + '>关闭</option></select>' +
    '<select class="think-effort" style="padding:6px 10px;background:var(--input-bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px">' +
    '<option value="high"' + (effort === 'high' ? ' selected' : '') + '>high</option>' +
    '<option value="max"' + (effort === 'max' ? ' selected' : '') + '>max</option></select>' +
    '<button class="remove-btn" onclick="this.parentElement.remove()">✕</button>';
  list.appendChild(div);
}

function addThinking() {
  addThinkingRow('', true, 'high');
}

function renderDomains(id, domains, removeFn) {
  const container = document.getElementById(id);
  container.innerHTML = domains.map(d =>
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

  // context_window
  const cwDefault = document.getElementById('contextWindowDefault').value.trim();
  if (cwDefault) {
    target.context_window = target.context_window || {};
    target.context_window.default = parseInt(cwDefault);
  }

  // 模型映射
  const mapping = { default: target.model_mapping?.default || 'deepseek-chat' };
  document.querySelectorAll('.mapping-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    if (inputs.length >= 2) {
      const src = inputs[0].value.trim();
      const tgt = inputs[1].value.trim();
      if (src && tgt) mapping[src] = tgt;
    }
  });
  target.model_mapping = mapping;

  // 思考配置
  const thinking = {};
  const globalEnabled = document.getElementById('thinkingGlobalEnabled').checked;
  if (globalEnabled) {
    thinking.enabled = true;
  }
  document.querySelectorAll('#thinkingList .mapping-row').forEach(row => {
    const model = row.querySelector('.think-model')?.value?.trim();
    const enabled = row.querySelector('.think-enabled')?.value === 'true';
    const effort = row.querySelector('.think-effort')?.value || 'high';
    if (model) {
      thinking[model] = { enabled, effort };
    }
  });
  target.thinking = Object.keys(thinking).length > 0 ? thinking : { default: { enabled: false } };

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
  updates['target.model_mapping'] = config.target.model_mapping;
  updates['target.thinking'] = config.target.thinking;
  updates['target.context_window'] = config.target.context_window;
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
  });
});

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
