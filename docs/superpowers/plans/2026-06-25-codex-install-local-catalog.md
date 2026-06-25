# codex install 本地化：移除对 server 进程的依赖

**日期**: 2026-06-25
**状态**: Plan

## 目标

`codex install` 当前通过 HTTP fetch `http://127.0.0.1:8056/codex/v1/models` 获取模型目录，强依赖 `pnpm dev serve` 在运行——没起 server 就 `network` 错误 abort。改为直接复用 `buildCodexModelsResponse` + `CodexCatalogCache` 在 CLI 进程内本地构建，install 独立运行。

## 背景（为何可以本地化）

- `/codex/v1/models` 端点（`src/server/codex.ts:24`）**无认证**，仅串联 `catalogCache.get()` + `buildCodexModelsResponse(settings, catalog)`
- `buildCodexModelsResponse`（`src/server/codex-catalog.ts:102`）是纯函数：遍历 `enumerateModelEntries(settings)` + 4 层 codex override 合并，不碰 token/路由
- `CodexCatalogCache`（`codex-catalog.ts:28`）内部 `execFile('codex', ['debug','models','--bundled'])`，无网络无认证
- 三者均无 server 运行时依赖（不碰 OAuth/TokenManager/RoutingTable/ModelGateway），CLI 可直接复用

## 改动

### 1. 下沉 catalog 逻辑到中立模块

`src/server/codex-catalog.ts` → `src/codex-catalog.ts`（与 `src/codex-types.ts` 同级）。该文件无 Hono/HTTP 依赖，本不属于 server 层；CLI 复用时 import `../server/` 路径别扭。

- 内部 import 路径：`../codex-types.js`→`./codex-types.js`、`../config.js`→`./config.js`、`../providers/model-types.js`→`./providers/model-types.js`
- server 侧 import 更新：`src/server/{app,types,codex}.ts` 的 `'./codex-catalog.js'` → `'../codex-catalog.js'`
- 测试配套移动：`test/server/codex-catalog.test.ts` → `test/codex-catalog.test.ts`（import 路径同步）
- `test/server/codex-endpoint.test.ts` 留原位（测端点），仅改 import 路径

### 2. `src/cli/codex-install.ts` 改为本地构建

**删除** HTTP 相关代码：`CodexEndpointErrorKind`、`CodexEndpointError`、`fetchCodexModelsResponse`、`mapEndpointError`、`codexModelsResponseSchema`。

**保留** `buildCodexBaseUrl`：仍用于写 `config.toml` 的 provider baseUrl（codex 运行时要连这个 URL 访问 server）。install 不再 fetch 它，但配置仍指向它。

**新增** import：`CodexCatalogCache`、`buildCodexModelsResponse`、`type CodexCatalogFetcher` from `'../codex-catalog.js'`，以及 `type CodexModelInfo` from `'../codex-types.js'`。

`CodexInstallOptions`：
- `fetchImpl?: typeof fetch` → `catalogFetcher?: CodexCatalogFetcher`

`runCodexInstall` 步骤 3 改为本地构建：
```ts
const cache = new CodexCatalogCache(options.catalogFetcher)
let modelsRes: { models: CodexModelInfo[] }
try {
  const catalog = await cache.get()
  modelsRes = buildCodexModelsResponse(settings, catalog)
} catch (err) {
  clack.log.error(mapCatalogError(err))
  clack.outro('Aborted')
  return
}
```

新增 `mapCatalogError(err)` 本地化提示（替代 `mapEndpointError`）：
- catalog 执行失败（`execFile` ENOENT / 超时 / 非零退出）→ `Failed to run 'codex debug models --bundled'. Is codex CLI installed and on PATH?`
- stdout 畸形 / `codexCatalogSchema` 校验失败 → `Malformed codex catalog output: <detail>`
- `template slug not in catalog`（`buildCodexModelsResponse` 抛）→ 透传 message，提示检查 settings 的 `codex.templateSlug`

步骤 4-8（非空检查 / selectModels / selectDefaultModel / 写 catalog / 编辑 config.toml）**不变**——它们只消费 `modelsRes.models: CodexModelInfo[]`，这是复用的关键接缝。

### 3. 测试重写 `test/cli/codex-install.test.ts`

models 来源从 mock HTTP 响应变为 `buildCodexModelsResponse(settings, catalog)`。测试 settings 改为配真实 provider/model，`catalogFetcher` 返回含 template slug 的 catalog（仿 `test/server/codex-catalog.test.ts` 的 `FULL_MODEL` + `CATALOG` 模式）。

- 删除 `fetchCodexModelsResponse` 的 3 个测试 + import
- 保留 `buildCodexBaseUrl` 的 2 个测试
- `runCodexInstall` 用例：`fetchImpl` → `catalogFetcher`（返回 `JSON.stringify({ models: [...] })`）；settings 配 provider/model 让 `enumerateModelEntries` 产出期望 slug
- "aborts on fetch network error" → "aborts when catalog fetcher throws"
- "aborts on empty models" → settings `providers: {}`（`buildCodexModelsResponse` 返回空）
- "skips both when catalog has a single model" → settings 只配 1 个 model
- 新增 "aborts when template slug not in catalog"（settings 配非法 `codex.templateSlug`，`buildCodexModelsResponse` 抛）

## 约束

- 不改 `applyCodexConfigEdits` / `codex-home` / `codex-toml` / catalog 文件格式
- `buildCodexBaseUrl` 仍写进 config.toml——install 不再 fetch 这个 URL，但 codex 运行时要连
- `defaultFetcher` 的 `execFile` 失败（codex 未装）须被步骤 3 的 try/catch 覆盖
- TS 严格：`catalogFetcher` 注入类型用 `CodexCatalogFetcher = () => Promise<string>`

## 验证

- `pnpm typecheck`
- `pnpm test test/cli/codex-install.test.ts`
- `pnpm test test/codex-catalog.test.ts test/server/codex-endpoint.test.ts`
- `pnpm test`（全量回归）
