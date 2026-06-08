# AGENTS.md — @llm-proxy/core

配置、Provider 工厂、协议映射、路由、插件系统、OAuth 和 CLI。是 server 的上游依赖。

## 设计决策

- **`${ENV_NAME}` 占位符：** 仅匹配完整字符串（`^\$\{...\}$`），部分匹配不替换。
- **OAuth fetch 组合：** `oauthFetch` 与 proxy fetch 按 OAuth → proxy → global 链式组合。OAuth 激活时不设 `apiKey`，避免 `Authorization` 头冲突。
- **Token 过期余量：** `isTokenValid` 使用 30 秒余量提前刷新。
- **models 端点：** `modelsEndpoint` 支持相对路径（拼接到 baseURL）或完整 URL。
- **Logger DI：** `createProviderRegistry` 通过依赖注入接收 `Logger`，不耦合日志实现。
- **统一类型：** `OpenAIModel`/`OpenAIModelList` 在 `protocols/openai-types.ts` 定义，CLI 和 models 共享。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm models:sync` | 交互式同步上游模型列表到 `settings.jsonc`（等价 `tsx src/cli/cli.ts models sync`） |
