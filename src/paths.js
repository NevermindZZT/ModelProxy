/**
 * 路径工具 — 处理 pkg 打包后的物理文件路径
 * 
 * pkg 会将所有 JS 文件打包进可执行文件的虚拟快照（snapshot）中。
 * 快照中的文件是只读的，且无法通过 fs.watch 监听。
 * 因此 config.yaml、certs/、proxy.log 等运行时文件必须放到 exe 同目录。
 * 
 * 本模块统一管理所有运行时文件路径。
 */

const path = require('path');
const fs = require('fs');

// 当前活动的配置名称，空字符串表示使用默认 config.yaml
let _configName = '';

/**
 * 获取运行时数据目录
 */
function getDataDir() {
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, '..');
}

/**
 * 获取活动配置持久化文件路径
 */
function _getActiveConfigPath() {
  return path.join(getDataDir(), '.active-config');
}

/**
 * 初始化时从持久化文件恢复配置名称
 */
function _initConfigName() {
  try {
    if (fs.existsSync(_getActiveConfigPath())) {
      const saved = fs.readFileSync(_getActiveConfigPath(), 'utf-8').trim();
      if (saved) _configName = saved;
    }
  } catch (e) {}
}
_initConfigName(); // 模块加载时立即恢复

/**
 * 设置活动配置名称并持久化
 */
function setConfigName(name) {
  _configName = name || '';
  try {
    fs.writeFileSync(_getActiveConfigPath(), _configName, 'utf-8');
  } catch (e) {}
}

/**
 * 获取活动配置名称
 */
function getConfigName() {
  return _configName;
}

/**
 * 获取配置文件路径
 * @param {string} [name] - 配置名称，不传则使用当前活动的配置名称
 */
function getConfigPath(name) {
  const configName = name !== undefined ? name : _configName;
  const fileName = configName ? `config-${configName}.yaml` : 'config.yaml';
  return path.join(getDataDir(), fileName);
}

/**
 * 获取日志文件路径 (proxy.log)
 */
function getLogPath() {
  return path.join(getDataDir(), 'proxy.log');
}

/**
 * 获取证书目录路径 (certs/)
 */
function getCertsDir() {
  return path.join(getDataDir(), 'certs');
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

module.exports = {
  getDataDir,
  getConfigPath,
  getConfigName,
  setConfigName,
  getLogPath,
  getCertsDir,
  ensureDir,
};
