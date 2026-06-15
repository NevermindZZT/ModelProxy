/**
 * ConfigManager — 配置管理器
 * 
 * 职责：
 * 1. 从 YAML 文件加载配置
 * 2. 提供运行时读写配置的 API
 * 3. 配置变更时，通知所有注册的监听器（热加载）
 * 4. 将运行时修改写回 YAML 文件持久化
 */

const fs = require('fs');
const YAML = require('./yaml-parser');
const logger = require('./logger');
const { getConfigPath } = require('./paths');

class ConfigManager {
  constructor() {
    this._config = null;
    this._watcher = null;
    this._listeners = new Set();
  }

  /**
   * 加载配置文件
   */
  load() {
    try {
      const raw = fs.readFileSync(getConfigPath(), 'utf-8');
      this._config = YAML.parse(raw);
      logger.info('配置文件加载成功:', getConfigPath());

      // 验证必要配置
      const rawKey = this._config.target && this._config.target.api_key;
      const hasApiKey = typeof rawKey === 'string' && rawKey.trim() !== '';
      if (!hasApiKey) {
        logger.info('ℹ 未在配置文件中设置 API Key，将使用原始请求中的 Authorization 头');
      }
      if (!this._config.target || !this._config.target.base_url) {
        logger.error('❌ 缺少 target.base_url 配置');
        process.exit(1);
      }

      // 确保 proxy 配置存在
      if (!this._config.proxy) {
        this._config.proxy = { host: '127.0.0.1', port: 8080 };
      }
      if (!this._config.target.models) {
        this._config.target.models = {};
      }
      if (!this._config.target.model_mapping) {
        this._config.target.model_mapping = { default: 'deepseek-chat' };
      }
      if (!this._config.intercept_domains) {
        this._config.intercept_domains = [
          'api.openai.com',
          'api.anthropic.com',
        ];
      }
      if (!this._config.smart_intercept_domains) {
        this._config.smart_intercept_domains = [];
      }

      return this._config;
    } catch (err) {
      logger.error('加载配置文件失败:', err.message);
      process.exit(1);
    }
  }

  /**
   * 获取当前配置（浅拷贝，防止外部直接修改）
   */
  get() {
    if (!this._config) {
      return this.load();
    }
    return this._config;
  }

  /**
   * 获取 target 配置的快捷方式
   */
  getTarget() {
    return this.get().target;
  }

  /**
   * 获取 proxy 配置的快捷方式
   */
  getProxy() {
    return this.get().proxy;
  }

  /**
   * 运行时更新配置（部分更新）
   * @param {string} section - 配置段路径，如 'target', 'target.base_url', 'target.model_mapping'
   * @param {*} value - 新的值
   */
  set(section, value) {
    const keys = section.split('.');
    let current = this._config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;

    logger.info(`配置已更新: ${section}`);
    this._notifyListeners();
  }

  /**
   * 批量更新配置
   * @param {object} updates - { 'target.base_url': '...', 'target.model_mapping': {...} }
   */
  applyUpdates(updates) {
    for (const [section, value] of Object.entries(updates)) {
      const keys = section.split('.');
      let current = this._config;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }
      current[keys[keys.length - 1]] = value;
    }
    logger.info('批量配置更新完成');
    this._notifyListeners();
  }

  /**
   * 将当前运行时配置写回 YAML 文件
   */
  save() {
    try {
      const yaml = this._toYAML(this._config);
      fs.writeFileSync(getConfigPath(), yaml, 'utf-8');
      logger.info('配置已保存到:', getConfigPath());
      return true;
    } catch (err) {
      logger.error('保存配置失败:', err.message);
      return false;
    }
  }

  /**
   * 将配置对象序列化为 YAML 格式（保持与原始配置文件风格一致）
   */
  _toYAML(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    const pad1 = '  '.repeat(indent + 1);
    let result = '';

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;

      if (typeof value === 'object' && !Array.isArray(value)) {
        result += `${pad}${key}:\n`;
        result += this._toYAML(value, indent + 1);
      } else if (Array.isArray(value)) {
        result += `${pad}${key}:\n`;
        for (const item of value) {
          result += `${pad1}- "${item}"\n`;
        }
      } else if (typeof value === 'boolean') {
        result += `${pad}${key}: ${value ? 'true' : 'false'}\n`;
      } else if (typeof value === 'number') {
        result += `${pad}${key}: ${value}\n`;
      } else if (typeof value === 'string') {
        if (value === '') {
          result += `${pad}${key}: ""\n`;
        } else if (/[:\[\]{}#,&\*!|>'"%@`\s]/.test(value)) {
          result += `${pad}${key}: "${value}"\n`;
        } else {
          result += `${pad}${key}: ${value}\n`;
        }
      }
    }
    return result;
  }

  /**
   * 注册配置变更监听器
   * @param {Function} listener - (config) => void
   * @returns {Function} 取消监听的函数
   */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * 通知所有监听器配置已变更
   */
  _notifyListeners() {
    for (const listener of this._listeners) {
      try {
        listener(this._config);
      } catch (err) {
        logger.error(`配置监听器执行失败: ${err.message}`);
      }
    }
  }

  /**
   * 监听文件变化（外部修改自动重载）
   */
  watch() {
    if (this._watcher) return;
    try {
      this._watcher = fs.watch(getConfigPath(), (eventType) => {
        if (eventType === 'change') {
          logger.info('检测到配置文件外部修改，正在重新加载...');
          try {
            const raw = fs.readFileSync(getConfigPath(), 'utf-8');
            const newConfig = YAML.parse(raw);
            this._config = newConfig;
            this._notifyListeners();
            logger.info('配置热重载完成');
          } catch (err) {
            logger.warn(`配置文件重载失败（可能是保存过程中的临时状态）: ${err.message}`);
          }
        }
      });
      logger.info('配置文件监听已启动:', getConfigPath());
    } catch (err) {
      logger.warn(`无法监听配置文件变化: ${err.message}`);
    }
  }

  /**
   * 停止文件监听
   */
  unwatch() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  /**
   * 销毁（清理资源）
   */
  destroy() {
    this.unwatch();
    this._listeners.clear();
  }
}

// 单例
let instance = null;

function getConfigManager() {
  if (!instance) {
    instance = new ConfigManager();
  }
  return instance;
}

module.exports = { ConfigManager, getConfigManager };
