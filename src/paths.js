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

/**
 * 获取运行时数据目录
 * - pkg 打包后: exe 所在目录
 * - 开发模式: 项目根目录（__dirname 的上级）
 */
function getDataDir() {
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  // 开发模式: src/ 的上级
  return path.resolve(__dirname, '..');
}

/**
 * 获取配置文件路径 (config.yaml)
 */
function getConfigPath() {
  return path.join(getDataDir(), 'config.yaml');
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
  getLogPath,
  getCertsDir,
  ensureDir,
};
