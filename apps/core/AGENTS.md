# AGENTS.md — @llm-proxy/core

配置、Provider 工厂、协议映射、路由、插件系统、OAuth 和 CLI。是 server 的上游依赖。

## CLI 结构

基于 Commander.js v15。入口 `cli.ts` 注册子命令，各命令在 `create*Command()` 中定义选项和 action handler，业务逻辑（`runModelsSync`/`runModelsList`）保持框架无关。

```
src/cli/
├── cli.ts              入口：program 定义 + addCommand
├── serve.ts            createServeCommand()
├── models.ts           createModelsCommand()（注册 sync + list）
├── models-sync.ts      createModelsSyncCommand() + runModelsSync()
├── models-list.ts      createModelsListCommand() + runModelsList()
├── context.ts          resolveCliContext()（共享 settings 解析）
├── discover-models.ts  上游模型发现（纯业务，不涉及 CLI 框架）
└── settings-writer.ts  JSONC 修改工具（纯业务，不涉及 CLI 框架）
```

## 设计决策

- **`${ENV_NAME}` 占位符：** 仅匹配完整字符串（`^\$\{...\}$`），部分匹配不替换。
- **OAuth fetch 组合：** `oauthFetch` 与 proxy fetch 按 OAuth → proxy → global 链式组合。OAuth 激活时不设 `apiKey`，避免 `Authorization` 头冲突。
- **Token 过期余量：** `isTokenValid` 使用 30 秒余量提前刷新。
- **models 端点：** `modelsEndpoint` 支持相对路径（拼接到 baseURL）或完整 URL。
- **Logger DI：** `createProviderRegistry` 通过依赖注入接收 `Logger`，不耦合日志实现。
- **统一类型：** `OpenAIModel`/`OpenAIModelList` 在 `protocols/openai-types.ts` 定义，CLI 和 models 共享。

## 命令

CLI 入口：`apps/core/src/cli/cli.ts`，通过 `pnpm dev <command>` 调用。

| 命令                   | 作用                                              |
| ---------------------- | ------------------------------------------------- |
| `pnpm dev serve`       | 启动 Hono HTTP 服务器（默认 tsx watch）           |
| `pnpm dev models sync` | 交互式同步上游模型列表到 `settings.jsonc`         |
| `pnpm dev models list` | 列出所有已配置的模型（`--format json` 输出 JSON） |
| `pnpm models:sync`     | 同 `pnpm dev models sync`（向后兼容）             |
