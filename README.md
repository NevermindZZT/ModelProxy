# ModelProxy - AI 模型 API 代理工具

## 概述

**ModelProxy** 是一个本地 HTTP/HTTPS 代理服务器，用于解决 **Android Studio GitHub Copilot** 中只能添加特定供应商（Azure、Anthropic、OpenAI、Gemini、Groq、OpenRouter）且无法配置 Base URL 的问题。

> 💡 **推荐方案**：使用 **OpenRouter** (`openrouter.ai`) 作为 Copilot 中的供应商，ModelProxy 智能拦截其 LLM 推理请求并转发到目标 API（如 DeepSeek）。API Key 在 Android Studio Copilot 设置中填写即可。

### 工作原理

```
┌─────────────────────┐     HTTPS      ┌──────────────────┐     HTTPS      ┌──────────────┐
│ Android Studio      │ ──────────────▶│  ModelProxy       │ ──────────────▶│  DeepSeek    │
│ (GitHub Copilot)    │                │  (localhost:8520) │                │  (或其他)    │
│ 供应商: OpenRouter  │                │                   │                │              │
└─────────────────────┘                └──────────────────┘                └──────────────┘
       │                                       │
       │ HTTP 代理 → 127.0.0.1:8520             │ 拦截请求，转换 API 格式
       │ API Key 填在 Copilot 设置中            │ (OpenRouter ↔ DeepSeek 等)
```

1. 在 Android Studio 中配置 HTTP 代理指向本工具
2. 在 GitHub Copilot 设置中选择 **OpenRouter** 作为供应商，填入 API Key
3. 代理拦截对 `openrouter.ai` 的请求
4. 获取真实模型列表（自动从目标供应商获取，合并自定义模型）
5. 转发 LLM 推理请求到目标供应商（如 DeepSeek）
6. 返回结果给 Copilot

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

# 3. 编辑 config.yaml 配置文件
```

### 配置

编辑 `config.yaml`:

```yaml
proxy:
  host: 127.0.0.1
  port: 8520

target:
  type: openai-compatible
  base_url: "https://api.deepseek.com"
  api_key: "sk-你的API密钥"  # 聊天请求使用此密钥转发到目标供应商
  
  # 模型定义：每个模型可定义完整能力
  models:
    gpt-5.4:
      target_model: deepseek-v4-flash
      name: "GPT-5.4"
      context_window: 1048576
      thinking: true
      reasoning_effort: high
      vision: false
    claude-opus-4.7:
      target_model: deepseek-v4-flash
      name: "Claude Opus 4.7"
      context_window: 1048576
      thinking: true
      vision: true

  # 默认模型（未在 models 中定义时使用）
  default_model: deepseek-v4-flash
  default_context_window: 1048576
```

> **API Key 说明**：
> - 不要求在 `config.yaml` 中填写 `api_key`，**直接在 Android Studio Copilot 设置中填写**即可
> - `config.yaml` 中的 `api_key` 作为后备方案：当 Copilot 未填写 key 时使用
> - 模型列表自动从目标供应商获取（如 DeepSeek），无需手动添加

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
   - Host: `127.0.0.1`  Port: `8520`
   - 勾选 "Proxy authentication" 不需要（留空）

2. **安装根 CA 证书**（用于 HTTPS 拦截）
   - 运行 `npm start` 首次启动后，会在 `certs/` 目录生成根 CA 证书
   - 运行 `node src/index.js --install-cert` 查看安装说明
   - Windows: 双击 `certs/root-ca-cert.pem`，选择安装到 **"受信任的根证书颁发机构"**

3. **在 GitHub Copilot 中添加模型**
   - 在 Android Studio 中打开 GitHub Copilot 设置
   - 添加模型，选择 **OpenRouter** 作为供应商（推荐）
   - 在 Copilot 设置中填入你的 API Key
   - 点击刷新模型列表，等待自动获取模型

## 支持的供应商

### 可拦截的供应商（Android Studio Copilot 可选的）
| 供应商 | 域名 | 说明 |
|--------|------|------|
| OpenRouter | openrouter.ai | ✅ 推荐，完整支持 |
| OpenAI | api.openai.com | ✅ 支持 |
| Anthropic | api.anthropic.com | ✅ 支持 |
| Gemini | generativelanguage.googleapis.com | 🔄 计划中 |
| Groq | api.groq.com | 🔄 计划中 |

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
http://127.0.0.1:8520/_modelproxy/admin
```

### 功能

| 功能 | 说明 |
|------|------|
| 🎯 **目标供应商** | 修改 Base URL、API Key、供应商类型、监听地址、日志级别 |
| 🔄 **模型定义** | 定义每个模型的完整能力（上下文窗口、目标模型、思考、视觉等） |
| 🌐 **拦截域名** | 管理直接拦截和智能拦截的域名列表 |
| 💾 **保存配置** | 修改后点击保存，配置立即写入文件并热加载生效 |

### 配置 API

```bash
# 获取当前配置
curl http://127.0.0.1:8520/_modelproxy/config

# 更新配置
curl -X PUT http://127.0.0.1:8520/_modelproxy/config \
  -H "Content-Type: application/json" \
  -d '{"target.base_url": "https://api.deepseek.com", "target.models": {...}}'

# 从文件重新加载配置
curl -X POST http://127.0.0.1:8520/_modelproxy/reload
```

## 配置热加载

ModelProxy 支持三种配置更新方式，全部**无需重启**：

1. **Web 管理面板** — 浏览器操作，一键保存生效
2. **REST API** — `PUT /_modelproxy/config`
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
