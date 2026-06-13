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

## 在线管理面板（Web UI 配置）

ModelProxy 内置了一个 Web 管理面板，可以在浏览器中直接修改配置，**无需重启代理**。

### 使用方式

启动代理后，打开浏览器访问：

```
http://127.0.0.1:8080/_modelproxy/admin
```

（如果修改了端口，替换 8080 为你的端口）

### 功能

| 功能 | 说明 |
|------|------|
| 🎯 **目标供应商** | 修改 Base URL、API Key、供应商类型、监听地址、日志级别 |
| 🔄 **模型映射** | 添加/删除/修改模型名称映射关系 |
| 🧠 **思考模式** | 按模型配置 thinking/reasoning 参数（DeepSeek V4 等） |
| 🌐 **拦截域名** | 管理直接拦截和智能拦截的域名列表 |
| 💾 **保存配置** | 修改后点击保存，配置立即写入文件并热加载生效 |

### 配置 API

管理面板背后提供了一套 REST API，方便集成到其他工具中：

```bash
# 获取当前配置
curl http://127.0.0.1:8080/_modelproxy/config

# 更新配置（部分更新）
curl -X PUT http://127.0.0.1:8080/_modelproxy/config \
  -H "Content-Type: application/json" \
  -d '{"target.base_url": "https://api.deepseek.com", "target.model_mapping": {...}}'

# 从文件重新加载配置
curl -X POST http://127.0.0.1:8080/_modelproxy/reload

# 健康检查
curl http://127.0.0.1:8080/_modelproxy/health
```

## 打包发布

可以将 ModelProxy 打包成单个可执行文件，用户无需安装 Node.js 即可运行。

### 方式一：使用 pkg（推荐，最成熟）

```bash
# 安装构建工具
npm install

# 构建（生成 Windows/Linux/macOS 三平台可执行文件）
npm run build:pkg

# 构建产物在 dist/ 目录
ls dist/
# model-proxy-win-x64.exe
# model-proxy-linux-x64
# model-proxy-macos-x64
```

### 方式二：使用 Node.js SEA（Node.js >= 20.11.0）

```bash
# 构建
npm run build:sea

# 构建产物在 dist/ 目录
ls dist/
# model-proxy-win-x64.exe  (Windows)
```

### 直接运行（无需打包）

```bash
# 确保已安装 Node.js 18+
npm start
```

也可以直接用 `start.bat`（Windows）或 `start.ps1`（PowerShell）启动。

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

# 打开管理面板（启动后）
# http://127.0.0.1:8080/_modelproxy/admin
```

## 技术架构

```
src/
├── index.js              # 入口文件
├── config.js             # 配置加载（兼容层）
├── config-manager.js     # 配置管理器（热加载、运行时读写）
├── logger.js             # 日志工具
├── yaml-parser.js        # YAML 解析器
├── cert-manager.js       # SSL 证书生成与管理
├── proxy-server.js       # HTTP/HTTPS 代理服务器核心 + 管理 API
├── router.js             # 请求路由与拦截决策
└── adapters/
    ├── openai-adapter.js     # OpenAI → 目标格式适配器
    └── anthropic-adapter.js  # Anthropic → OpenAI → 目标格式适配器
```

## 配置热加载

ModelProxy 支持三种配置更新方式，全部**无需重启**：

1. **Web 管理面板** — 浏览器操作，一键保存生效
2. **REST API** — `PUT /_modelproxy/config`，适合 CI/CD 集成
3. **文件编辑** — 直接修改 `config.yaml`，自动检测变化并重载

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

**Q: 配置改了没用？**
A: 从 v1.0.0 开始，所有配置修改都会立即生效，无需重启代理。如果遇到配置未生效，可以尝试在管理面板中点击"从文件重新加载"。
