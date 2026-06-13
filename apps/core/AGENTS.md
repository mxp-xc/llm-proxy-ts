# AGENTS.md — @llm-proxy/core

配置、Provider 工厂、协议映射、路由、插件系统、OAuth 和 CLI。是 server 的上游依赖。

## 模块结构

```
src/providers/
├── registry.ts           Provider 注册表（按 provider.type 分派）
├── protocol-types.ts     共享协议类型（FinishReason、RenderResultInput、toErrorMessage、isRecord）
├── models.ts             模型发现（listModels、getModel）
├── model-types.ts        模型列表类型（OpenAIModel、OpenAIModelList）
├── shared/
│   ├── aisdk-types.ts    AI SDK 统一输入类型（AISDKInput）
│   ├── provider-factory.ts  共享 Provider 工厂（createOpenAICompatibleProvider、sanitizeHeaders、createProxyFetch）
│   ├── renderer-utils.ts    共享 Renderer 工具（stringValue、toolCallIdValue）
│   ├── protocol-utils.ts    共享协议映射工具（mapProviderOptions）
│   ├── error-format.ts      协议错误格式化器（ProtocolErrorFormatter 接口 + openAI/anthropic 两种实现）
│   └── strategy.ts          策略模式接口（ProtocolStrategy）
├── openai-compatible/
│   ├── protocol.ts       OpenAI Chat 请求 schema + AI SDK 映射
│   ├── renderer.ts       OpenAI Chat 响应渲染（JSON + SSE）
│   ├── types.ts          OpenAI Chat 响应类型（OpenAIChatCompletion）
│   └── strategy.ts       openaiCompatibleStrategy 实例
├── openai-responses/
│   ├── protocol.ts       OpenAI Responses 请求 schema + AI SDK 映射
│   ├── renderer.ts       OpenAI Responses 响应渲染（命名事件 SSE 状态机）
│   ├── types.ts          OpenAI Responses 响应类型
│   └── strategy.ts       openaiResponsesStrategy 实例
└── anthropic/
    ├── provider.ts       Anthropic 工厂（@ai-sdk/anthropic）
    ├── protocol.ts       Anthropic 请求 schema + AI SDK 映射
    ├── renderer.ts       Anthropic 响应渲染（JSON + 命名事件 SSE）
    ├── types.ts          Anthropic 类型定义
    └── strategy.ts       anthropicStrategy 实例
```

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

- **Provider 类型 discriminated union：** `providerConfigSchema` 使用 `z.discriminatedUnion('type', [...])`，支持 `openai-compatible` 和 `anthropic`。`registry.ts` 按 `provider.type` 分派到对应工厂。
- **`${ENV_NAME}` 占位符：** 仅匹配完整字符串（`^\$\{...\}$`），部分匹配不替换。
- **OAuth fetch 组合：** `oauthFetch` 与 proxy fetch 按 OAuth → proxy → global 链式组合。OAuth 激活时不设 `apiKey`，避免 `Authorization` 头冲突。
- **Token 过期余量：** `isTokenValid` 使用 30 秒余量提前刷新。
- **models 端点：** `options.modelsEndpoint` 仅对 `openai-compatible` 类型生效；`anthropic` 类型不支持 OpenAI 协议发现。
- **Provider options 分层：** 类型特定/行为控制字段统一放在 `provider.options` 中，但每个 provider 类型有自己的 options schema，Zod 按类型验证：
  - 通用字段（`streamOnly`、`enableFlatModelLookup`）所有类型共享；
  - `openai-compatible` 额外支持 `modelsEndpoint`、`includeUsage`；
  - `anthropic` 额外支持 `anthropicVersion`；
  - `openai` 额外支持 `organization`、`project`。
  顶层只保留通用连接/认证/路由字段（`type`、`baseURL`、`apiKey`、`headers`、`models`、`plugins`、`oauth`）。旧版顶层配置字段会在加载时抛出明确的迁移错误。
- **Logger DI：** `createProviderRegistry` 通过依赖注入接收 `Logger`，不耦合日志实现。
- **Anthropic tool_choice：** 始终是对象格式（`{ type: 'auto' }` 等），不兼容裸字符串。
- **策略模式：** 每种协议格式实现 `ProtocolStrategy<TRequest>` 接口，封装验证、映射、渲染和错误格式化。Server 端通过 `handleProtocolRequest` 通用函数统一处理，消除三个 handler 的重复逻辑。

## 命令

CLI 入口：`apps/core/src/cli/cli.ts`，通过 `pnpm dev <command>` 调用。

| 命令                   | 作用                                              |
| ---------------------- | ------------------------------------------------- |
| `pnpm dev serve`       | 启动 Hono HTTP 服务器（默认 tsx watch）           |
| `pnpm dev models sync` | 交互式同步上游模型列表到 `settings.jsonc`         |
| `pnpm dev models list` | 列出所有已配置的模型（`--format json` 输出 JSON） |
| `pnpm models:sync`     | 同 `pnpm dev models sync`（向后兼容）             |
