#!/usr/bin/env node

const { loadConfig, getConfig } = require('./config');
const { getConfigManager } = require('./config-manager');
const logger = require('./logger');
const ProxyServer = require('./proxy-server');
const { getRootCACertPath, getRootCACrtPath } = require('./cert-manager');
const fs = require('fs');
const path = require('path');

// ANSI 颜色
const colors = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

function printBanner() {
  console.log(`
${colors.cyan}╔══════════════════════════════════════════════════════════════╗
║                    ${colors.bold}ModelProxy v1.0.0${colors.reset}${colors.cyan}                     ║
║         AI 模型 API 代理 - 请求拦截与转发工具              ║
╚══════════════════════════════════════════════════════════════╝${colors.reset}
  `);
}

function printInstallInstructions() {
  const certPemPath = getRootCACertPath();
  const certCrtPath = getRootCACrtPath();
  console.log(`
${colors.yellow}═══════════════════ 安装说明 ═══════════════════${colors.reset}

${colors.bold}1️⃣  配置 Android Studio HTTP 代理${colors.reset}
   Settings → Appearance & Behavior → System Settings → HTTP Proxy
   选择 "Manual proxy configuration"
   Host: 127.0.0.1  Port: 8080

${colors.bold}2️⃣  安装根 CA 证书（用于 HTTPS 拦截）${colors.reset}
   安装前先运行代理一次以生成证书，然后:
   
   ${colors.bold}Windows 用户:${colors.reset}
     双击 ${colors.cyan}${certCrtPath}${colors.reset}
     选择 "安装证书" → "本地计算机" → "受信任的根证书颁发机构"
     
   ${colors.bold}macOS 用户:${colors.reset}
     sudo security add-trusted-cert -d -r trustRoot \\
       -k /Library/Keychains/System.keychain ${certPemPath}
   
   ${colors.bold}Linux 用户:${colors.reset}
     sudo cp ${certPemPath} /usr/local/share/ca-certificates/modelproxy.crt
     sudo update-ca-certificates

${colors.yellow}═══════════════════════════════════════════════════${colors.reset}
  `);
}

function main() {
  printBanner();

  // 检查命令参数
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  }
  if (arg === '--install-cert' || arg === '-c') {
    printInstallInstructions();
    process.exit(0);
  }
  if (arg === '--gen-cert' || arg === '-g') {
    // 仅生成证书
    logger.info('正在生成 CA 证书...');
    require('./cert-manager').getOrCreateRootCA();
    logger.info('✅ 证书已生成:', getRootCACertPath());
    process.exit(0);
  }

  // 加载配置 — 使用 ConfigManager（支持热加载）
  const configManager = getConfigManager();
  const config = configManager.load();
  logger.setLevel(config.log_level || 'info');

  // 启动配置文件监听（外部修改自动重载）
  configManager.watch();

  // 打印安装说明
  printInstallInstructions();

  // 启动代理服务器 - 传入 configManager 而非静态 config
  const proxy = new ProxyServer(configManager);
  proxy.start().catch(err => {
    logger.error('启动代理服务器失败:', err.message);
    process.exit(1);
  });
}

function printHelp() {
  console.log(`
${colors.bold}用法:${colors.reset}
  node src/index.js [选项]

${colors.bold}选项:${colors.reset}
  -h, --help          显示帮助信息
  -c, --install-cert  显示证书安装说明
  -g, --gen-cert      仅生成 CA 证书（不启动代理）
  `);
}

process.on('uncaughtException', (err) => {
  logger.error('未捕获的异常:', err.message);
});

process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝:', reason);
});

main();
