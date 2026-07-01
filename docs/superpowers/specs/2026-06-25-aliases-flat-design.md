# aliases flat 支持与 models list 渲染改造

## Context

当前 `aliases` 是 `string[]`，裸名暴露完全跟随 provider/全局的 `enableFlatModelLookup`（`isFlatLookupEnabled`），且 `models list` 表格不展示 aliases 列。两个问题：

1. alias 无法独立控制是否以裸名暴露，必须开整个 provider/全局 flat，粒度太粗。
2. alias 默认不带 provider 前缀，裸名访问依赖 flat 开关；`models list` 读取了 aliases 却不渲染。

本次给 flat 加 per-model、per-alias 两层独立开关，并让 alias 默认带 provider 前缀入口（始终可路由，不依赖 flat）；同时改造 `models list` 表格展示 aliases 列、多行垂直居中。

## 语义模型

### 配置形态

```jsonc
"glm-5.2": {
  "upstreamModel": "glm-5.2",
  "flat": true,                  // model 级 flat（新增，默认 false）
  "aliases": [
    "glm-5.2[1m]",               // string → 带前缀入口
    { "name": "glm-5.2-long", "flat": true }  // record → 带前缀 + 裸名
  ]
}
```

### 暴露入口规则

- **带前缀入口（始终有）**：`provider/modelKey`、每个 alias 的 `provider/<name>`。
- **裸名入口（额外，B 语义 = 保留带前缀再加裸名）**：
  - modelKey 裸名 = `isFlatLookupEnabled(provider) || model.flat`
  - alias 裸名 = `isFlatLookupEnabled(provider) || model.flat || alias.flat`
- 三层 OR：全局/provider → model → alias，越下层越细，任一开启即暴露裸名。string 形式无 `flat` 字段，等价 `flat:false`。
- alias `name` 仅禁 `/`（带前缀入口由系统拼 `provider/name`；含 `/` 在现有 `routing.ts:112` 已被双段解析拒绝，本次把该拒绝前移到 schema 层尽早暴露）；其他字符不禁、不 trim，与 modelKey 约束一致。

## 改动点

### 1. Schema — `src/config.ts`

参考既有 `pluginEntrySchema`（`:15-33`）的 `z.union([string, object]).transform` 范式：

```ts
const aliasEntryObjectSchema = z.object({
  name: z.string().min(1),
  flat: z.boolean().optional().default(false),
})
export const aliasEntrySchema = z
  .union([z.string().min(1), aliasEntryObjectSchema])
  .transform((v) => (typeof v === 'string' ? { name: v, flat: false } : v))
  .refine((v) => !v.name.includes('/'), "alias name must not contain '/'")
```

`modelRouteConfigSchema` 内：

- `aliases: z.array(aliasEntrySchema).optional().default([])` —— 运行时类型 `AliasEntry[]`（`{ name: string; flat: boolean }`，`flat` 经 `.default` 为必填）。
- 新增 `flat: z.boolean().optional()` —— model 级开关（无 `.default`，`z.infer` 为 `boolean | undefined`，现有配置字面量无需写 `flat`；代码用 `!!model.flat` 归一）。

要点：

- 导出 `AliasEntry` 类型，并在 `src/index.ts` re-export（与 `ModelEntry` 同处）。
- `ModelRouteInput`（`z.input`）的 `aliases` 类型 = `(string | { name: string; flat?: boolean })[]`；`settings-writer` 透传（实现时确认无需改）；`models sync` 暂不支持交互式配 alias，保持现状。
- `exactOptionalPropertyTypes`：`AliasEntry.flat` 是 `boolean`（非可选），实现时勿写成 `flat?: boolean`。

### 2. 枚举核心 — `src/providers/model-types.ts`

`ModelEntry` 字段调整：**移除旧 `flat`**，新增 `modelFlat: boolean`；`aliases` 类型改 `AliasEntry[]`。`enumerateModelEntries` 保持**纯枚举不抛错**（被 `listModels`/`buildCodexModelsResponse` 调用，抛错会把配置错误变成 `/v1/models` 运行时 500）。ids 构建：

```
providerFlat = isFlatLookupEnabled(provider, settings)
modelFlat    = providerFlat || !!model.flat
ids = [ `${providerName}/${modelKey}` ]
   + (modelFlat ? [modelKey] : [])
   + flatMap(alias => [
       `${providerName}/${alias.name}`,
       ...(modelFlat || alias.flat ? [alias.name] : [])
     ])
```

新 ids 顺序固定，`listModels` / `collectRows` / `buildCodexModelsResponse` 三处共用 `ids` 自动一致。更新文件顶部注释里旧的 ids 顺序说明。冲突检测不在本函数，见 §3。

### 3. 路由 — `src/routing.ts`

所有配置错误检测集中在 `RoutingTable.fromSettings` **构造期**（启动期暴露，非运行时 500）：

- **flatRoutes 构建（`:63-70`）**：`flatRoutes` 仍为全局跨 provider Map。遍历所有裸名入口（modelKey 裸名 + 各 alias 裸名）注册，注册前 ambiguous 检测；跨 provider 裸名冲突沿用 `"ambiguous flat route '<selector>' is configured"` 文案。
- **带前缀入口唯一性检测**（新增）：同一 provider 内 `{modelKey} ∪ {所有 alias name}` 必须全局唯一（覆盖 alias==modelKey、跨 model alias 重复、同 model 内 alias 重复），冲突抛错（文案如 `"duplicate model selector '<name>' in provider '<p>'"`）。
- **resolve 裸名分支（`:86-110`）**：移除 `anyFlatEnabled` 前置检查与 `flat_lookup_disabled` 错误码，直接 `flatRoutes.get(selector)`，命中返回、未命中抛 `unknown_model`。
- **resolve provider/model 分支（`:132-140`）**：`model.aliases.includes(x)` → `model.aliases.some(a => a.name === x)`，解析 `provider/<alias-name>` 带前缀入口。

### 4. Models API — `src/providers/models.ts`

`getModel` 两个分支都改：

- `slashIndex > 0` 分支（`:24-38`）：补 alias 遍历，使 `provider/<alias-name>` 命中。
- 扁平分支（`:40-54`）：flat 判定从 `isFlatLookupEnabled(provider)` 改为按入口类型判定——modelKey 裸名 `providerFlat || model.flat`、alias 裸名 `providerFlat || model.flat || alias.flat`，否则 `model.flat=true` 但 provider flat 关时 `getModel('glm-5.2')` 会误返回 null。
- 返回的 `id` 始终 = 入参 `modelId`（保持现状，不改成 modelKey）。
- `listModels`（`:13-18`）：无逻辑改动，输出条目随 `ids` 增长。

### 5. CLI 渲染 — `src/cli/models/list.ts`

- `collectRows` 改为一行一模型（不再按 `ids` flatMap 展开）。`ModelRow` 含 `modelFlat: boolean`、`aliases: AliasEntry[]`、主 `id = provider/modelKey`。
- `formatTable` 重写渲染：行高 `H = max(1, aliases.length)`。
  - **单值列**（id/provider/upstreamModel/context/input/output）垂直居中（上补 `floor((H-1)/2)`、下补 `ceil((H-1)/2)`）。
  - **Aliases 列按 alias 顺序每子行一个**（非垂直居中），`*` 标记 = `row.modelFlat || alias.flat`（表示该 alias 有裸名入口）；无裸名入口的 alias 仍显示 name 不带 `*`；空 aliases 显示 `-`。
- 按物理行输出。多行渲染牺牲 grep 友好换取紧凑性；未来可加 `--oneline` 标志回退（v0 不做）。

示例（3 alias，H=3，单值列居中中间行；`glm-5.2-long` 有裸名入口带 `*`，其余无）：

```
ID                Provider  Upstream Model  Aliases          Context  Input  Output
───────────────   ────────  ──────────────  ──────────────   ───────  ─────  ──────
                                            glm-5.2[1m]
zhipu/glm-5.2     zhipu     glm-5.2         glm-5.2-long *   128M     -      -
                                            glm-5.2-fast
openai/gpt-4o     openai    gpt-4o          -                128M     -      -
```

### 6. schema 生成

重新跑 `pnpm generate:schema` 更新 `config/settings.schema.json`（aliases 在 openai-compatible / anthropic / openai 三处全内联；重新生成后行号会漂移，实现时以实际为准）。

## 测试

更新既有用例适配新语义与 ids 顺序。**ids 顺序新期望**（锁定顺序语义）：

- flat 关 + 1 string alias `a` → `['p/m', 'p/a']`
- flat 开 + 2 string alias `a1,a2` → `['p/m', 'm', 'p/a1', 'a1', 'p/a2', 'a2']`
- flat 关 + 1 record alias `{name:'a', flat:true}` → `['p/m', 'p/a', 'a']`（modelKey 裸名不出现，alias 裸名出现）

更新/新增：

- `test/config.test.ts`：空字符串 name 拒绝、`name` 含 `/` 拒绝、缺 `name` 的 record 拒绝、空白 name 不 trim（与现有 `min(1)` 一致）。
- `test/routing.test.ts`：alias 解析、flat、ambiguous 迁到 `AliasEntry[]`；新增跨 provider `alias.flat` 同名裸名冲突；移除 `flat_lookup_disabled` 断言改为 `unknown_model`。
- `test/providers/enumerate-models.test.ts`：`entry.flat` 断言改 `entry.modelFlat`；`entry.aliases` 是 `AliasEntry[]`；ids 顺序新期望。
- `test/providers/models.test.ts`：`listModels` / `getModel` 带前缀 alias；`getModel` 扁平分支 `model.flat=true`（provider flat 关）命中。
- `test/server/models-endpoint.test.ts`：/v1/models 输出含 `provider/<alias-name>`。
- `test/codex-catalog.test.ts`：flat 关 + 1 alias → 2 slugs `['provider/alias', 'provider/modelKey']`；`provider/<alias>` slug 与主 slug 共享 `entry.limit`。
- 新增：`model.flat` 开启、record `flat:true` 独立裸名、`provider/<alias-name>` 带前缀入口、带前缀入口唯一性冲突（同 provider alias==modelKey / 跨 model alias 重复）、`models list` 多行垂直居中渲染。

## 迁移 / Breaking

- string alias 从"flat 时裸名"变为"带前缀入口"：依赖裸名访问需改配 `model.flat` 或 `alias.flat:true`。
- alias `name` 禁 `/`。
- `flat_lookup_disabled` 错误码移除：裸名未命中统一 `unknown_model`，客户端原据该码判断"需开 flat"的逻辑改为 `unknown_model` + 配置自查。
- alias 始终在 codex `/v1/models` 响应作为 `provider/<alias-name>` slug 出现（以前仅 flat 开启时）。
- `listModels`/codex 响应数组顺序变化：alias 带前缀入口 `provider/<alias-name>` 始终出现并按配置顺序插入 ids，依赖响应位置取默认模型的客户端可能受影响。
- `ModelEntry.flat` 字段移除、更名 `modelFlat`：语义从 `isFlatLookupEnabled(provider)`（纯 provider/全局 flat）变为 `providerFlat || model.flat`（合并 model 级开关），非纯更名（公共导出 breaking，`index.ts` re-export 同步；下游读 `entry.flat` 判断 provider flat 会被 `model.flat` 污染）。
- 带前缀入口冲突检测在启动期（`fromSettings`）暴露，非运行时 500。
- v0 范围接受 breaking；`config/settings.schema.json` 重新生成。

## 验证

1. `pnpm typecheck` 通过。
2. `pnpm test` 全绿。
3. `pnpm generate:schema` 后 `config/settings.schema.json` 含 `aliases` union 形态与 model 级 `flat`。
4. `pnpm dev serve` 启动，用 `provider/<alias>` 与裸名 alias 分别请求 `/v1/chat/completions`，确认路由命中同一 upstreamModel。
5. `pnpm dev models list` 确认 aliases 列展示、多行垂直居中。
