# AGENTS.md — @llm-proxy/core

本包提供配置系统、Provider 工厂和 CLI 工具，是 server 的上游依赖。

## 模块职责

| 模块 | 职责 |
|---|---|
| `config.ts` | Zod schema（`settingsSchema`、`providerConfigSchema`、`oauthConfigSchema` 等），JSONC 解析，`${ENV}` 占位符解析，JSON Schema 生成 |
| `openai-compatible.ts` | 创建 `@ai-sdk/openai-compatible` provider 实例，可选 OAuth fetch 和 undici 代理，敏感 header 脱敏 |
| `env.ts` | 从工作区根目录和应用目录加载 `.env` / `.env.local` |
| `resolve-settings-path.ts` | 解析配置文件路径（默认 → `LLM_PROXY_SETTINGS_FILE` 环境变量覆盖） |
| `oauth/types.ts` | OAuth 类型定义（`OAuthToken`、`TokenStore`、`AuthStatus`、`OAuthError`） |
| `oauth/token-store.ts` | `auth.json` 读写（原子写入，JSON 损坏容错） |
| `oauth/token-manager.ts` | `TokenManager` — token 生命周期管理（有效性检查、刷新、交换、并发去重、持久化） |
| `oauth/index.ts` | OAuth 模块重导出 |
| `index.ts` | 公共 API 重导出 |

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm models:sync` | 交互式同步上游模型列表到 `settings.jsonc` |

等价于 `tsx src/cli/cli.ts models sync`。

## CLI 工具

`src/cli/` 目录包含交互式命令行工具：

| 命令 | 入口 | 作用 |
|---|---|---|
| `models sync` | `cli.ts` → `discover-models.ts` + `models-sync.ts` | 发现上游可用模型并交互式选择写入 `settings.jsonc` |

- `discover-models.ts` — 调用上游 models 端点获取模型列表，支持自定义 URL、OAuth token 和静态 headers
- `models-sync.ts` — 交互式选择模型并写入配置（仅写入与默认值不同的字段）；支持 OAuth provider 自动刷新 token
- `settings-writer.ts` — JSONC 配置的安全读写（保留注释和格式）

## 导出 API

`index.ts` 导出的公共接口：

- **配置：** `settingsSchema`, `providerConfigSchema`, `oauthConfigSchema`, `pluginConfigSchema`, `modelRouteConfigSchema` 及对应类型
- **配置工具：** `loadSettingsFromFile`, `resolveEnvPlaceholders`, `generateSettingsJsonSchema`, `writeSettingsJsonSchema`
- **环境：** `loadEnvironmentFiles`
- **路径：** `resolveSettingsPath`
- **Provider：** `createOpenAICompatibleProvider`, `createProxyFetch`, `sanitizeHeaders`
- **OAuth：** `TokenManager`, `OAuthError`, `isTokenValid`, `isTokenExpired`, `classifyStatus`, `refreshAccessToken`, `fetchClientCredentialsToken`, `exchangeAuthorizationCode`, `loadTokenStore`, `saveTokenStore`, `getToken`, `setToken`

## 设计决策

- **`${ENV_NAME}` 占位符：** 配置加载时解析。仅匹配完整字符串（`^\$\{...\}$`）；`prefix-${VAR}` 等部分匹配不会被替换。
- **代理支持：** 可选 undici `ProxyAgent`，支持配置 TLS 验证。
- **OAuth fetch 组合：** `createOpenAICompatibleProvider` 接受可选的 `oauthFetch` 参数，与 proxy fetch 组合（OAuth → proxy → global）。OAuth 激活时不设 `apiKey`，避免 `Authorization` 头冲突。
- **Token 过期余量：** `isTokenValid` 使用 30 秒余量提前刷新，避免请求途中 token 过期。
- **自定义 models 端点：** `providerConfigSchema.modelsEndpoint` 支持相对路径（拼接到 baseURL）或完整 URL 覆盖。未设置时默认 `{baseURL}/models`。
- **CLI OAuth 支持：** `models sync` 命令自动检测 OAuth provider，使用 `TokenManager` 解析 token。`authorization_code` 流程未登录时跳过并提示登录 URL；`client_credentials` 流程自动刷新。

## 关键依赖

| 依赖 | 用途 |
|---|---|
| `@ai-sdk/openai-compatible` | 创建 AI SDK 兼容的 provider 实例 |
| `jsonc-parser` | JSONC 配置文件的解析和修改（保留注释） |
| `zod-to-json-schema` | 从 Zod schema 生成 JSON Schema |
| `undici` | 代理请求支持（`ProxyAgent`） |
| `@clack/prompts` | CLI 交互式选择界面 |

## 测试

- `test/config.test.ts` — 配置 schema 和加载
- `test/discover-models.test.ts` — 模型发现
- `test/settings-writer.test.ts` — JSONC 配置写入
- `test/oauth-token-store.test.ts` — auth.json 读写
- `test/oauth-token-manager.test.ts` — token 生命周期管理
