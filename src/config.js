const fs = require('fs');
const path = require('path');
const YAML = require('./yaml-parser');
const logger = require('./logger');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.yaml');

let config = null;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = YAML.parse(raw);
    logger.info('配置文件加载成功:', CONFIG_PATH);

    // 验证必要配置
    // api_key 为可选项 — 如果未配置，代理将从原始请求的 Authorization 头中提取
    const hasApiKey = config.target && config.target.api_key && config.target.api_key.trim() !== '';
    if (!hasApiKey) {
      logger.info('ℹ 未在配置文件中设置 API Key，将使用原始请求中的 Authorization 头');
    }
    if (!config.target || !config.target.base_url) {
      logger.error('❌ 缺少 target.base_url 配置');
      process.exit(1);
    }

    return config;
  } catch (err) {
    logger.error('加载配置文件失败:', err.message);
    process.exit(1);
  }
}

function getConfig() {
  if (!config) {
    return loadConfig();
  }
  return config;
}

module.exports = { loadConfig, getConfig };
