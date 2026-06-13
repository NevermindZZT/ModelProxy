# ModelProxy - AI 模型 API 代理工具

## 概述

**ModelProxy** 是一个本地 HTTP/HTTPS 代理服务器，用于解决 **Android Studio GitHub Copilot** 中只能添加特定供应商（Azure、Anthropic、OpenAI、Gemini、Groq、OpenRouter）且无法配置 Base URL 的问题。

### 工作原理

```
┌─────────────────────┐     HTTPS      ┌──────────────────┐     HTTPS      ┌──────────────┐
│ Android Studio      │ ──────────────▶│  ModelProxy       │ ──────────────▶│  DeepSeek    │
│ (GitHub Copilot)    │                │  (localhost:8080) │                │  (或其他)    │
└─────────────────────┘                └──────────────────┘                └──────────────┘
       │                                       │
       │ Android Studio HTTP Proxy              │ 拦截请求，转换 API 格式
       │ 设置为 127.0.0.1:8080                  │ (OpenAI ↔ DeepSeek 等)
```

1. 在 Android Studio 中配置 HTTP 代理指向本工具
2. GitHub Copilot 的 API 请求经过本代理
3. 代理拦截对 `api.openai.com`、`api.anthropic.com` 等域名的 HTTPS 请求
4. 将请求格式转换为目标供应商（如 DeepSeek）的 API 格式
5. 转发请求并返回结果

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org/) 18+ (推荐使用 LTS 版本)

### 安装

```bash
# 1. 克隆项目
git clone <项目地址>
cd ModelProxy

# 2. 安装依赖
npm install

# 3. 配置目标供应商
编辑 config.yaml 文件，填入你的 API Key 和目标地址
```

### 配置

编辑 `config.yaml`:

```yaml
proxy:
  host: "127.0.0.1"
  port: 8080

target:
  # openai-compatible: 兼容 OpenAI API 格式（DeepSeek、通义千问、Moonshot 等）
  # anthropic-compatible: 兼容 Anthropic API 格式
  type: "openai-compatible"
  
  # 以 DeepSeek 为例
  base_url: "https://api.deepseek.com"
  api_key: "sk-你的DeepSeekAPI密钥"
  
  model_mapping:
    "gpt-4o": "deepseek-chat"
    "gpt-4o-mini": "deepseek-chat"
    "default": "deepseek-chat"
```

### 运行

```bash
# 启动代理
npm start

# 开发模式（文件变化自动重启）
npm run dev
```

### 在 Android Studio 中配置

1. **设置 HTTP 代理**
   - 打开 Settings → Appearance & Behavior → System Settings → HTTP Proxy
   - 选择 **Manual proxy configuration**
   - Host: `127.0.0.1`  Port: `8080`
   - 勾选 "Proxy authentication" 不需要（留空）

2. **安装根 CA 证书**（用于 HTTPS 拦截）
   - 运行 `npm start` 首次启动后，会在 `certs/` 目录生成根 CA 证书
   - 运行 `node src/index.js --install-cert` 查看安装说明
   - Windows: 双击 `certs/root-ca-cert.pem`，选择安装到 **"受信任的根证书颁发机构"**

3. **在 GitHub Copilot 中添加模型**
   - 在 Android Studio 中打开 GitHub Copilot 设置
   - 添加模型，选择 **OpenAI** 作为供应商
   - API Key 可以填任意值（实际请求会被代理拦截并转发）

## 支持的供应商

### 可拦截的供应商（Android Studio Copilot 可选的）
| 供应商 | 域名 | 说明 |
|--------|------|------|
| OpenAI | api.openai.com | ✅ 完整支持 |
| Anthropic | api.anthropic.com | ✅ 格式自动转换 |
| Gemini | generativelanguage.googleapis.com | 🔄 计划中 |
| Groq | api.groq.com | 🔄 计划中 |
| OpenRouter | api.openrouter.ai | 🔄 计划中 |
| Azure | *.openai.azure.com | 🔄 计划中 |

### 可转发的目标供应商
| 供应商 | API 格式 | 配置示例 |
|--------|----------|----------|
| **DeepSeek** | OpenAI 兼容 | `base_url: "https://api.deepseek.com"` |
| 通义千问 (Qwen) | OpenAI 兼容 | `base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1"` |
| Moonshot | OpenAI 兼容 | `base_url: "https://api.moonshot.cn/v1"` |
| Yi (零一万物) | OpenAI 兼容 | `base_url: "https://api.lingyiwanwu.com/v1"` |
| 智谱 GLM | OpenAI 兼容 | `base_url: "https://open.bigmodel.cn/api/paas/v4"` |
| 百度千帆 | OpenAI 兼容 | `base_url: "https://qianfan.baidubce.com/v2"` |
| 硅基流动 | OpenAI 兼容 | `base_url: "https://api.siliconflow.cn/v1"` |

## 命令参考

```bash
# 启动代理
node src/index.js

# 仅生成 CA 证书
node src/index.js -g, --gen-cert

# 显示证书安装说明
node src/index.js -c, --install-cert

# 显示帮助
node src/index.js -h, --help
```

## 技术架构

```
src/
├── index.js              # 入口文件
├── config.js             # 配置加载
├── logger.js             # 日志工具
├── yaml-parser.js        # YAML 解析器
├── cert-manager.js       # SSL 证书生成与管理
├── proxy-server.js       # HTTP/HTTPS 代理服务器核心
├── router.js             # 请求路由与拦截决策
└── adapters/
    ├── openai-adapter.js     # OpenAI → 目标格式适配器
    └── anthropic-adapter.js  # Anthropic → OpenAI → 目标格式适配器
```

## 注意事项

1. **HTTPS 证书**：本工具使用 MITM（中间人）技术拦截 HTTPS 请求，首次运行会生成自签名根 CA 证书，需要手动安装到系统信任存储
2. **仅用于开发环境**：建议仅在开发环境中使用
3. **API Key 安全**：请妥善保管你的 API Key
4. **网络要求**：需要能够访问目标供应商的 API 服务器

## 常见问题

**Q: Copilot 提示 "Authentication failed"?**
A: 检查是否已安装根 CA 证书，且 Android Studio 的 HTTP 代理配置正确。

**Q: 代理启动失败，端口被占用?**
A: 修改 `config.yaml` 中的 `proxy.port` 为其他端口（如 8081）。

**Q: 响应速度慢?**
A: 请求需要经过两次网络传输（Android Studio → 代理 → 目标 API），这是正常现象。
