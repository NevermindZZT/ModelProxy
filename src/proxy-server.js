const https = require('https');
const http = require('http');
const { URL } = require('url');
const tls = require('tls');
const logger = require('./logger');
const { getOrCreateRootCA, generateCertForDomain } = require('./cert-manager');
const RequestRouter = require('./router');

class ProxyServer {
  constructor(config) {
    this.config = config;
    this.router = new RequestRouter(config);
    this.rootCA = null;
    this.recentRequests = []; // 保存最近的请求记录用于状态页展示
    this.startTime = new Date();
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
   * 处理普通 HTTP 请求
   */
  handleRequest(req, res) {
    const clientAddr = req.socket?.remoteAddress || 'unknown';
    const url = req.url;

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
