const { getConfigManager } = require('./config-manager');

/**
 * 兼容层 — 保持原有 API 不变
 * 内部委托给 ConfigManager 单例
 */
function loadConfig() {
  return getConfigManager().load();
}

function getConfig() {
  return getConfigManager().get();
}

module.exports = { loadConfig, getConfig };
