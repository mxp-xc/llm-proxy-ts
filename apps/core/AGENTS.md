# AGENTS.md — @llm-proxy/core

本包提供配置系统、Provider 工厂和 CLI 工具，是 server 的上游依赖。

## 模块职责

| 模块 | 职责 |
|---|---|
| `config.ts` | Zod schema（`settingsSchema`、`providerConfigSchema` 等），JSONC 解析，`${ENV}` 占位符解析，JSON Schema 生成 |
| `openai-compatible.ts` | 创建 `@ai-sdk/openai-compatible` provider 实例，可选 undici 代理，敏感 header 脱敏 |
| `env.ts` | 从工作区根目录和应用目录加载 `.env` / `.env.local` |
| `resolve-settings-path.ts` | 解析配置文件路径（默认 → `LLM_PROXY_SETTINGS_FILE` 环境变量覆盖） |
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

- `discover-models.ts` — 调用上游 `/v1/models` 获取模型列表
- `models-sync.ts` — 交互式选择模型并写入配置（仅写入与默认值不同的字段）
- `settings-writer.ts` — JSONC 配置的安全读写（保留注释和格式）

## 导出 API

`index.ts` 导出的公共接口：

- **配置：** `settingsSchema`, `providerConfigSchema`, `pluginConfigSchema`, `modelRouteConfigSchema` 及对应类型
- **配置工具：** `loadSettingsFromFile`, `resolveEnvPlaceholders`, `generateSettingsJsonSchema`, `writeSettingsJsonSchema`
- **环境：** `loadEnvironmentFiles`
- **路径：** `resolveSettingsPath`
- **Provider：** `createOpenAICompatibleProvider`, `createProxyFetch`, `sanitizeHeaders`

## 设计决策

- **`${ENV_NAME}` 占位符：** 配置加载时解析。仅匹配完整字符串（`^\$\{...\}$`）；`prefix-${VAR}` 等部分匹配不会被替换。
- **代理支持：** 可选 undici `ProxyAgent`，支持配置 TLS 验证。

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
