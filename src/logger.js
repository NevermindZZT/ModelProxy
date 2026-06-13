const fs = require('fs');
const path = require('path');
const { getLogPath } = require('./paths');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = 'info';
let logFileStream = null;

// 日志文件路径（使用 paths.js 获取运行时物理路径）
const LOG_FILE = getLogPath();

function setLevel(level) {
  if (LEVELS[level] !== undefined) {
    currentLevel = level;
  }
}

function ensureLogFile() {
  if (!logFileStream) {
    try {
      logFileStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf-8' });
      logFileStream.write(`\n=== ModelProxy started at ${new Date().toISOString()} ===\n`);
    } catch (err) {
      console.error('无法创建日志文件:', err.message);
    }
  }
}

function formatMessage(level, args) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
}

function log(level, ...args) {
  if (LEVELS[level] >= LEVELS[currentLevel]) {
    const formatted = formatMessage(level, args);
    
    // 输出到控制台
    if (level === 'error') {
      console.error(formatted);
    } else if (level === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    // 输出到日志文件
    ensureLogFile();
    if (logFileStream) {
      logFileStream.write(formatted + '\n');
    }
  }
}

function getLogFilePath() {
  return LOG_FILE;
}

module.exports = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
  setLevel,
  getLogFilePath,
};
