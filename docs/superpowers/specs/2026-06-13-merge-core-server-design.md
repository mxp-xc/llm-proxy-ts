# server + core 包合并设计

**日期**: 2026-06-13
**状态**: 待审核

## 1. 目标

将 `apps/core` 和 `apps/server` 两个包合并为一个单包，项目根目录即为包根。同时：

- 对 `app.ts`（503 行）进行路由拆分和模块化
- 清理死代码和 deprecated 导出
- 精简 `index.ts` 桶文件（从 ~146 个导出精简至 ~50 个）
- 修复依赖版本不一致
- 测试目录与源码目录严格镜像

## 2. 合并后目录结构

```
llm-proxy-ts/
├── src/
│   ├── index.ts                      # 精简后的公共 API 导出
│   ├── config.ts
│   ├── config-helpers.ts
│   ├── env.ts
│   ├── resolve-settings-path.ts
│   ├── types.ts
│   ├── routing.ts                    # 唯一版本（core 版本）
│   │
│   ├── cli/
│   │   ├── cli.ts
│   │   ├── serve.ts
│   │   ├── models.ts
│   │   ├── models-sync.ts
│   │   ├── models-list.ts
│   │   ├── context.ts
│   │   ├── discover-models.ts
│   │   └── settings-writer.ts
│   │
│   ├── providers/
│   │   ├── registry.ts
│   │   ├── models.ts
│   │   ├── model-types.ts
│   │   ├── protocol-types.ts
│   │   ├── shared/
│   │   │   ├── aisdk-types.ts
│   │   │   ├── provider-factory.ts
│   │   │   ├── renderer-utils.ts
│   │   │   ├── protocol-utils.ts
│   │   │   ├── error-format.ts
│   │   │   ├── strategy.ts
│   │   │   └── stream-collector.ts
│   │   ├── openai-compatible/
│   │   │   ├── protocol.ts
│   │   │   ├── renderer.ts
│   │   │   ├── strategy.ts
│   │   │   └── types.ts
│   │   ├── openai-responses/
│   │   │   ├── protocol.ts
│   │   │   ├── renderer.ts
│   │   │   ├── strategy.ts
│   │   │   └── types.ts
│   │   ├── anthropic/
│   │   │   ├── protocol.ts
│   │   │   ├── provider.ts
│   │   │   ├── renderer.ts
│   │   │   ├── strategy.ts
│   │   │   └── types.ts
│   │   └── openai/
│   │       ├── protocol-types.ts
│   │       └── provider.ts
│   │
│   ├── oauth/
│   │   ├── index.ts
│   │   ├── token-manager.ts
│   │   ├── token-store.ts
│   │   └── types.ts
│   │
│   ├── plugins/
│   │   ├── helpers.ts
│   │   ├── loader.ts
│   │   ├── registry.ts
│   │   ├── store-adapter.ts
│   │   ├── types.ts
│   │   └── vendor-sse-error.ts
│   │
│   └── server/                       # 拆分后的 Hono 服务器
│       ├── app.ts                    # createApp() + 路由注册（~120 行）
│       ├── types.ts                  # ModelGateway、AppDependencies、AppEnv
│       ├── gateway.ts                # defaultGateway
│       ├── handle-protocol.ts        # handleProtocolRequest + handleUpstreamError
│       ├── stream-inspect.ts         # inspectFirstStreamChunk（+ 私有 replayStream、inspectStreamChunk）
│       ├── stream-utils.ts           # withRequestTimeout、RequestTimeoutError、readableStreamFromAsyncIterable
│       ├── server.ts                 # main() + 进程信号
│       ├── logging.ts                # pino 日志工厂
│       └── oauth/
│           ├── callback.ts
│           └── startup.ts
│
├── test/                             # 与 src/ 严格镜像
│   ├── config.test.ts
│   ├── routing.test.ts
│   ├── cli/
│   │   ├── discover-models.test.ts
│   │   └── settings-writer.test.ts
│   ├── providers/
│   │   ├── registry.test.ts
│   │   ├── protocol-types.test.ts
│   │   ├── anthropic/
│   │   │   ├── protocol.test.ts
│   │   │   └── renderer.test.ts
│   │   ├── openai-compatible/
│   │   │   ├── protocol.test.ts
│   │   │   └── renderer.test.ts
│   │   ├── openai-responses/
│   │   │   ├── protocol.test.ts
│   │   │   └── renderer.test.ts
│   │   └── shared/
│   │       ├── renderer-utils.test.ts
│   │       └── stream-collector.test.ts
│   ├── plugins/
│   │   ├── helpers.test.ts
│   │   ├── loader.test.ts
│   │   ├── registry.test.ts
│   │   └── store-adapter.test.ts
│   ├── oauth/
│   │   ├── token-manager.test.ts
│   │   └── token-store.test.ts
│   └── server/
│       ├── app.test.ts              # 原 endpoint/health/smoke/security 测试合入
│       ├── logging.test.ts
│       ├── handle-protocol.test.ts   # 新文件如有独立测试
│       └── oauth/
│           ├── callback.test.ts
│           └── startup.test.ts
│
├── scripts/
│   ├── generate-schema.ts
│   └── generate-schema-debug.ts
├── plugins/                          # 外部插件示例（不变）
├── config/                           # 示例配置 + JSON Schema（不变）
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── AGENTS.md / CLAUDE.md
```

## 3. app.ts 路由拆分

### 3.1 拆分前后对比

| 文件                 | 职责                                                                     | 行数 |
| -------------------- | ------------------------------------------------------------------------ | ---- |
| **拆分前** `app.ts`  | 全部混合                                                                 | 503  |
| **拆分后** `app.ts`  | createApp() + 路由注册 + 中间件                                          | ~120 |
| `types.ts`           | ModelGateway、AppDependencies、AppEnv                                    | ~40  |
| `gateway.ts`         | defaultGateway 实现                                                      | ~20  |
| `handle-protocol.ts` | handleProtocolRequest + handleUpstreamError                              | ~150 |
| `stream-inspect.ts`  | inspectFirstStreamChunk（+ 私有 replayStream、inspectStreamChunk）       | ~80  |
| `stream-utils.ts`    | withRequestTimeout、RequestTimeoutError、readableStreamFromAsyncIterable | ~50  |

### 3.2 handleProtocolRequest 闭包变量注入

`handleProtocolRequest` 原定义在 `createApp()` 内部，捕获 4 个闭包变量。提取为独立函数后通过参数对象注入：

```typescript
// src/server/handle-protocol.ts
export interface ProtocolContext {
  routingTable: RoutingTable
  settings: Settings
  gateway: ModelGateway
  resolveModel: (
    providerName: string,
    upstreamModel: string,
    headers: Record<string, string>,
  ) => unknown
}

export function handleProtocolRequest<TRequest>(
  c: Context<AppEnv>,
  strategy: ProtocolStrategy<TRequest>,
  ctx: ProtocolContext,
): Promise<Response>
```

`app.ts` 中构造 `ProtocolContext` 传入。`resolveModel` 从闭包提取为可独立测试的函数。

### 3.3 stream-inspect.ts 内部函数

`replayStream` 和 `inspectStreamChunk` 是 `inspectFirstStreamChunk` 的内部辅助函数，保持为模块私有（不导出）。只有 `inspectFirstStreamChunk` 对外导出。

## 4. 删除清单

| 路径                                                | 原因                                   |
| --------------------------------------------------- | -------------------------------------- |
| `apps/server/src/protocols/openai-chat.ts`          | 死代码，app.ts 使用 core 的 strategy   |
| `apps/server/src/protocols/openai-chat-renderer.ts` | 死代码                                 |
| `apps/server/src/protocols/openai-models.ts`        | 死代码                                 |
| `apps/server/src/routing.ts`                        | 重复，依赖废弃 API，统一使用 core 版本 |
| `apps/core/src/protocols/`                          | 空壳目录                               |
| `apps/core/temp-gen.ts`                             | 临时调试文件                           |
| `apps/core/test-ai-sdk-messages.ts`                 | 临时调试文件                           |
| `apps/core/test-ai-sdk-messages2.ts`                | 临时调试文件                           |
| `apps/core/test-payload.ts`                         | 临时调试文件                           |
| `pnpm-workspace.yaml`                               | 单包不需要 workspace                   |
| `apps/core/package.json`                            | 合并为根 package.json                  |
| `apps/server/package.json`                          | 合并为根 package.json                  |
| `apps/core/tsconfig.json`                           | 合并为根 tsconfig.json                 |
| `apps/server/tsconfig.json`                         | 合并为根 tsconfig.json                 |
| `apps/core/vitest.config.ts`                        | 合并为根 vitest.config.ts              |
| `apps/server/vitest.config.ts`                      | 合并为根 vitest.config.ts              |

## 5. 依赖优化

### 5.1 依赖合并

core 和 server 的 dependencies 合并，去重 `ai`、移除 `@llm-proxy/core` workspace 依赖：

```
dependencies:
  @ai-sdk/anthropic
  @ai-sdk/openai
  @ai-sdk/openai-compatible
  @hono/node-server
  @clack/prompts
  ai                          # 统一版本 ^6.0.197（修复 server 的 latest）
  commander
  dotenv
  hono
  jsonc-parser
  pino
  undici
  zod-to-json-schema
```

### 5.2 版本修复

- `ai`: server 的 `"latest"` → `"^6.0.197"`
- 所有 `"latest"` 标签依赖替换为锁定版本号（`@ai-sdk/openai-compatible`、`jsonc-parser`、`undici`、`@hono/node-server`、`hono`、`pino`）
- `dotenv` 去重：根 devDependencies 和 core dependencies 各有一份，合并后只保留根 package.json 中的一份

### 5.3 deprecated 导出清理

删除死代码后，以下 deprecated 符号可安全移除（无活跃消费者）：

| 符号                   | 替代                                 |
| ---------------------- | ------------------------------------ |
| `PluginConfig` type    | `PluginEntry`                        |
| `resolvePluginConfigs` | 不再需要                             |
| `assertKnownPlugins`   | 不再需要                             |
| `loadTokenStore`       | `loadAuthFile` + `extractTokenStore` |
| `saveTokenStore`       | `saveAuthFile` + `mergeTokenStore`   |

## 6. index.ts 桶文件精简

当前 `index.ts` 约 146 个导出，64% 无外部消费者。合并后只保留被 server/CLI 实际使用的 ~50 个核心符号：

**保留导出**（按领域）：

- Config: schema、Settings 类型、loadSettingsFromFile、resolveEnvPlaceholders、resolveSettingsPath 等
- Provider: ProviderRegistry、createProviderRegistry、createOAuthFetch、KeySelection、LanguageModelResult
- Routing: RoutingTable、RoutingError、RouteMatch
- Strategy: openaiCompatibleStrategy、openaiResponsesStrategy、anthropicStrategy、ProtocolStrategy、ProtocolErrorFormatter
- Plugin: PluginRegistry、Plugin 类型族、registerBuiltInPlugin、loadPlugin、inspectVendorSseError
- OAuth: TokenManager、OAuthToken、TokenStore、AuthStatus
- Models: listModels、getModel
- Server: createApp、ModelGateway、AppDependencies
- Error: OAuthError、openAIErrorFormat、anthropicErrorFormat

**不导出**（仅在内部使用）：

- Provider 工厂函数（`createOpenAICompatibleProvider`、`createAnthropicProvider`、`createOpenAIProvider`）— 只被 registry.ts 内部使用
- 协议验证器/映射器（`validateOpenAIChatRequest`、`mapOpenAIChatRequestToAISDKInput` 等）— 只通过 strategy 内部使用
- 协议渲染器（`renderOpenAIChatCompletion`、`renderOpenAIChatCompletionSSE` 等）— 只通过 strategy 内部使用
- OAuth 细粒度函数（`loadAuthFile`、`saveAuthFile`、`isTokenValid` 等）— 被 TokenManager 内部调用
- 大量 Anthropic/OpenAI Responses 类型 — 无外部消费者

## 7. 配置文件变更

### 7.1 根 package.json

```jsonc
{
  "name": "llm-proxy",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "types": "./src/index.ts",
    },
  },
  "scripts": {
    "dev": "tsx src/cli/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "generate:schema": "tsx scripts/generate-schema.ts",
    "models:sync": "tsx src/cli/cli.ts models sync",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
  },
  "dependencies": {
    // 见第 5.1 节
  },
  "devDependencies": {
    "@types/node": "latest",
    "prettier": "^3.8.3",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest",
  },
}
```

关键变化：

- `pnpm test` 从 `pnpm -r test` 改为 `vitest run`
- `pnpm typecheck` 从 `pnpm -r typecheck` 改为 `tsc --noEmit`
- `dotenv`、`zod` 从 devDependencies 移除（dotenv 已在 dependencies，zod 通过 ai-sdk 间接可用）
- `scripts.dev` 保持 `"tsx src/cli/cli.ts"`

### 7.2 tsconfig.json（新建）

```jsonc
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "baseUrl": ".",
    "ignoreDeprecations": "6.0",
    "types": ["node", "vitest"],
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts", "scripts/**/*.ts"],
}
```

关键变化：

- 移除 `paths` 别名（`@llm-proxy/core` 不再存在）
- `include` 统一指向 `src/`、`test/`、`scripts/`

### 7.3 vitest.config.ts（新建）

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
```

### 7.4 路径修复

| 文件                 | 原路径                                                     | 新路径                                   |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `src/cli/serve.ts`   | `resolve(cliDir, '../../../../apps/server/src/server.ts')` | `resolve(cliDir, '../server/server.ts')` |
| `src/cli/context.ts` | `resolve(cliDir, '../../../..')`                           | `resolve(cliDir, '../../..')`            |

### 7.5 Import 路径变更

所有 `from '@llm-proxy/core'` 导入改为相对路径：

| 文件位置                       | 原 import                | 新 import               |
| ------------------------------ | ------------------------ | ----------------------- |
| `src/server/app.ts`            | `from '@llm-proxy/core'` | `from '../index.js'`    |
| `src/server/server.ts`         | `from '@llm-proxy/core'` | `from '../index.js'`    |
| `src/server/oauth/callback.ts` | `from '@llm-proxy/core'` | `from '../../index.js'` |
| `src/server/oauth/startup.ts`  | `from '@llm-proxy/core'` | `from '../../index.js'` |

core 内部的相对导入（`./config.js`、`./providers/shared/strategy.js` 等）保持不变。

## 8. 测试目录规范

**规则**：`src/X/Y/Z.ts` → `test/X/Y/Z.test.ts`，严格镜像源码目录结构。

- 测试文件名与源文件名完全一致，只加 `.test`
- 原来多个 endpoint 测试文件（chat-endpoint、messages-endpoint、health、security-and-plugins、smoke 等）都测试 `app.ts`，合并为 `test/server/app.test.ts`，内部用 `describe` 分组
- 不加文件名前缀（目录已提供上下文）
- 单元/集成测试暂不加后缀（`test/server/` 天然是集成测试区）

## 9. 文件操作汇总

| 操作        | 来源                                                    | 目标                                                                                |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 移动        | `apps/core/src/**`                                      | `src/`                                                                              |
| 移动+拆分   | `apps/server/src/app.ts`                                | `src/server/{app,types,gateway,handle-protocol,stream-inspect,stream-utils}.ts`     |
| 移动        | `apps/server/src/server.ts`                             | `src/server/server.ts`                                                              |
| 移动        | `apps/server/src/logging.ts`                            | `src/server/logging.ts`                                                             |
| 移动        | `apps/server/src/oauth/**`                              | `src/server/oauth/`                                                                 |
| 移动+重命名 | `apps/core/test/openai-chat.test.ts` 等                 | `test/providers/openai-compatible/protocol.test.ts` 等（按镜像规则重命名+重排目录） |
| 移动+重命名 | `apps/server/test/chat-endpoint.test.ts` 等多个端点测试 | `test/server/app.test.ts`（合并为单文件，内部 describe 分组）                       |
| 移动+重命名 | `apps/server/test/oauth-*.test.ts`                      | `test/server/oauth/callback.test.ts`、`test/server/oauth/startup.test.ts`           |
| 移动+重命名 | `apps/server/test/logging.test.ts`                      | `test/server/logging.test.ts`                                                       |
| 移动        | `apps/server/scripts/**`                                | `scripts/`                                                                          |
| 删除        | `apps/server/src/protocols/**`                          | 死代码                                                                              |
| 删除        | `apps/server/src/routing.ts`                            | 重复                                                                                |
| 删除        | `apps/core/src/protocols/`                              | 空壳                                                                                |
| 删除        | `apps/core/temp-gen.ts` 等临时文件                      | 调试产物                                                                            |
| 删除        | `apps/core/package.json`                                | 合并                                                                                |
| 删除        | `apps/server/package.json`                              | 合并                                                                                |
| 删除        | `apps/core/tsconfig.json`                               | 合并                                                                                |
| 删除        | `apps/server/tsconfig.json`                             | 合并                                                                                |
| 删除        | `apps/core/vitest.config.ts`                            | 合并                                                                                |
| 删除        | `apps/server/vitest.config.ts`                          | 合并                                                                                |
| 删除        | `pnpm-workspace.yaml`                                   | 不再需要                                                                            |
| 修改        | 根 `package.json`                                       | 依赖合并 + scripts 更新                                                             |
| 新建        | `tsconfig.json`                                         | 单包配置                                                                            |
| 新建        | `vitest.config.ts`                                      | 单包测试配置                                                                        |
| 修改        | `src/index.ts`                                          | 精简导出 + 增加 server 公共导出                                                     |
| 修改        | `src/cli/serve.ts`                                      | 路径更新                                                                            |
| 修改        | `src/cli/context.ts`                                    | 路径更新                                                                            |
| 修改        | 根 `AGENTS.md`                                          | 更新为单包结构                                                                      |
