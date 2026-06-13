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
    if (!config.target || !config.target.api_key || config.target.api_key === 'sk-your-deepseek-api-key-here') {
      logger.warn('⚠ 请在 config.yaml 中配置目标供应商的 API Key');
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
