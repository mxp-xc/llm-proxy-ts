# aliases flat 支持与 models list 渲染改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 flat 加 per-model、per-alias 两层独立开关，让 alias 默认带 provider 前缀入口，并改造 `models list` 表格（一行一模型、aliases 列 `\n` 分割、多行垂直居中）。

**Architecture:** `aliases` 从 `string[]` 迁移为 `AliasEntry[]`（`{ name; flat }`，union+transform），`ModelEntry` 用 `modelFlat` 取代 `flat`。ids 构建按"带前缀入口始终有 + 裸名 = `providerFlat || model.flat || alias.flat`"重写。路由在 `fromSettings` 构造期集中检测（裸名 ambiguous + 带前缀唯一性）。`models list` 改一行一模型 + 多行垂直居中渲染。

**Tech Stack:** TypeScript (ESM/NodeNext, `zod/v3`, `exactOptionalPropertyTypes`), Vitest, Hono, Commander.js。

## Global Constraints

- 所有本地导入用 `.js` 扩展名（ESM + NodeNext）；`type` 导入用 `import type`。
- `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax` 开启。
- `AliasEntry.flat` 经 `.default(false)` 后 `z.infer` 为 `boolean`（必填），勿写 `flat?: boolean`。
- `ModelRouteConfig.flat`（model 级）用 `z.boolean().optional()`（**无** `.default`），`z.infer` 为 `boolean | undefined`，现有测试字面量无需补 `flat`；代码用 `!!model.flat` 归一。
- 测试构造 `Settings` **复用各文件既有的构造函数**：`test/providers/enumerate-models.test.ts`、`test/providers/models.test.ts` 各有本地 `makeSettings(providers, enableFlatModelLookup=false)`；`test/routing.test.ts` 已 import helper `makeSettings`（`test/helpers/settings.ts`）。新测试**不引入与本地同名的 helper import**（会报 duplicate identifier）。
- provider/model 字面量须含 `headers: {}`、`plugins: []`（`.default()` 后 `z.infer` 必填，`makeSettings` 不经 Zod parse，类型必须严格）。
- 新增/修改的 `aliases` 字面量用 object 形式 `[{ name: 'x', flat: false }]`（`AliasEntry[]` 严格类型不接受裸 string）。
- 仅改本任务相关文件；不提交 `.env`/`settings.jsonc`/`auth.json`。
- spec: `docs/superpowers/specs/2026-06-25-aliases-flat-design.md`。

---

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/config.ts` | `aliasEntrySchema`/`AliasEntry`/`modelRouteConfigSchema` | 改 |
| `src/index.ts` | 公共 re-export | 改（补 `AliasEntry`） |
| `src/providers/model-types.ts` | `ModelEntry`（`modelFlat` 取代 `flat`）、`enumerateModelEntries` ids 构建 | 改 |
| `src/routing.ts` | `fromSettings` 构造期检测、`resolve` 两分支 | 改 |
| `src/providers/models.ts` | `getModel` 两分支 | 改 |
| `src/cli/models/list.ts` | `collectRows`、`renderRows`/`formatTable` 多行垂直居中 | 改 |
| `config/settings.schema.json` | 重新生成 | 改 |
| `test/config.test.ts` | schema 校验 | 改+增 |
| `test/providers/enumerate-models.test.ts` | ids 构建/顺序 | 改 |
| `test/providers/models.test.ts` | listModels/getModel | 改+增 |
| `test/routing.test.ts` | 路由/冲突检测 | 改+增 |
| `test/server/models-endpoint.test.ts` | /v1/models | 改 |
| `test/codex-catalog.test.ts` | codex slugs | 改 |
| `test/cli/models-list.test.ts` | list 渲染（既有，已测 `formatLimitNum`，补 `renderRows` 用例） | 改+增 |

---

## Task 1: Schema 与类型迁移（行为等价）

**Files:**
- Modify: `src/config.ts:50-59`（新增 `aliasEntrySchema`/`AliasEntry`，改 `modelRouteConfigSchema`）
- Modify: `src/index.ts:9-18`（`export type` 块补 `AliasEntry`）
- Modify: `src/providers/model-types.ts:33-73`（`ModelEntry.aliases: AliasEntry[]`，`enumerateModelEntries` 用 `alias.name`，行为等价）
- Modify: `src/routing.ts:64,137`（适配 `AliasEntry`，行为等价）
- Modify: `src/providers/models.ts:50`（适配 `AliasEntry`，行为等价）
- Modify: `src/cli/models/list.ts:11-19`（`ModelRow.aliases: AliasEntry[]`，行为等价）
- Modify: 非空 alias 测试字面量（见 Step 6 位置清单）
- Modify: `config/settings.schema.json`（`pnpm generate:schema`）
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `AliasEntry`（`{ name: string; flat: boolean }`，from `src/config.ts`），`modelRouteConfigSchema.aliases: AliasEntry[]`、`.flat: boolean`。

- [ ] **Step 1: 写失败测试（schema 校验）**

追加到 `test/config.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { modelRouteConfigSchema } from '../src/config.js'

describe('modelRouteConfigSchema aliases', () => {
  it('accepts string aliases and normalizes to {name, flat:false}', () => {
    const r = modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: ['a1', 'a2'] })
    expect(r.aliases).toEqual([{ name: 'a1', flat: false }, { name: 'a2', flat: false }])
    expect(r.flat).toBe(false)
  })

  it('accepts record aliases with flat', () => {
    const r = modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [{ name: 'a', flat: true }, 'b'] })
    expect(r.aliases).toEqual([{ name: 'a', flat: true }, { name: 'b', flat: false }])
  })

  it('accepts model-level flat', () => {
    expect(modelRouteConfigSchema.parse({ upstreamModel: 'm', flat: true }).flat).toBe(true)
  })

  it('rejects empty alias name', () => {
    expect(() => modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [''] })).toThrow()
    expect(() => modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [{ name: '' }] })).toThrow()
  })

  it('rejects alias name containing "/" (string and record)', () => {
    expect(() => modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: ['a/b'] })).toThrow()
    expect(() => modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [{ name: 'a/b' }] })).toThrow()
  })

  it('rejects record alias missing name', () => {
    expect(() => modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [{ flat: true }] })).toThrow()
  })

  it('does not trim whitespace-only alias name', () => {
    expect(modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: ['  '] }).aliases).toEqual([{ name: '  ', flat: false }])
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/config.test.ts`
Expected: FAIL（`aliasEntrySchema` 未定义，`r.aliases` 仍是 string[]）

- [ ] **Step 3: 实现 schema（`src/config.ts`）**

在 `modelLimitSchema`（`:50`）之后、`modelRouteConfigSchema`（`:52`）之前插入。refine 提到外层以同时覆盖 string 和 record 形式（与 spec §1 等价，更简洁）：

```ts
// ─── Alias entry schema ─────────────────────────────────────────
const aliasEntryObjectSchema = z.object({
  name: z.string().min(1),
  flat: z.boolean().optional().default(false),
})

/** alias 条目：string 短写等价于 { name, flat:false }。transform 后统一禁 "/" */
export const aliasEntrySchema = z
  .union([z.string().min(1), aliasEntryObjectSchema])
  .transform((v) => (typeof v === 'string' ? { name: v, flat: false } : v))
  .refine((v) => !v.name.includes('/'), "alias name must not contain '/'")

export type AliasEntry = z.infer<typeof aliasEntrySchema>
```

改 `modelRouteConfigSchema`（`:52-59`）：

```ts
export const modelRouteConfigSchema = z.object({
  upstreamModel: z.string().min(1),
  aliases: z.array(aliasEntrySchema).optional().default([]),
  flat: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional().default({}),
  plugins: z.array(pluginEntrySchema).optional().default([]),
  limit: modelLimitSchema.optional(),
  codex: codexModelOverrideSchema.optional(),
})
```

- [ ] **Step 4: re-export `AliasEntry`（`src/index.ts`）**

加到 `:9-18` 的 `export type { ... } from './config.js'` 块（`AliasEntry` 定义在 config.ts，与 `ModelRouteConfig` 同处）。

- [ ] **Step 5: 类型迁移 — 源码（行为等价）**

`src/providers/model-types.ts` import 改：
```ts
import type { AliasEntry, Settings } from '../config.js'
```
`ModelEntry.aliases`（`:37`）改 `AliasEntry[]`。`enumerateModelEntries` 内 `:57-59`：
```ts
        ids.push(alias.name)
```
（`aliases: [...model.aliases]` `:65` 不变。`flat` 字段、ids 构建逻辑本轮不变。）

`src/routing.ts:64`：
```ts
        for (const selector of [entry.modelKey, ...entry.aliases.map((a) => a.name)]) {
```
`src/routing.ts:137`：
```ts
      if (model.aliases.some((a) => a.name === requestedModel)) {
```
`src/providers/models.ts:50`：
```ts
      if (model.aliases.some((a) => a.name === modelId)) {
```
`src/cli/models/list.ts` import 加 `AliasEntry`，`ModelRow.aliases`（`:15`）改 `AliasEntry[]`。`collectRows` 逻辑不变。

- [ ] **Step 6: 改非空 alias 测试字面量为 object 形式（行为等价）**

`AliasEntry[]` 严格类型不接受裸 string，下列位置 `aliases: ['x']` 改为 `aliases: [{ name: 'x', flat: false }]`（多元素逐个转）：

- `test/routing.test.ts:21,74,111,129`（`['default']`）
- `test/server/models-endpoint.test.ts:24,236,358,425`（`['default']`）
- `test/codex-catalog.test.ts:142,172`（`['g']`）
- `test/providers/models.test.ts:88,153`（`['default']`）
- `test/providers/enumerate-models.test.ts:29,71,100,111,174`（`['default']`、`['default','fast']`、`['a1']`、`['a2']`、`['x','y']`）

仅改字面量形态，断言留到 Task 2/3。空 `aliases: []` 不动。

另外 `test/providers/enumerate-models.test.ts` 有两处 alias **形状**断言：`:52` `expect(entry.aliases).toEqual(['default'])` 与 `:179` `toEqual(['x','y'])`。字面量改 object 后这两行同步改为 `toEqual([{ name: 'default', flat: false }])` / `toEqual([{ name: 'x', flat: false }, { name: 'y', flat: false }])`，否则 Task 1 Step 8 无法全绿。

注：`ModelRouteConfig.flat` 用 `z.boolean().optional()`（无 `.default`），现有 `aliases: []` 等字面量**无需**补 `flat` 字段。

- [ ] **Step 7: 重新生成 schema**

Run: `pnpm generate:schema`
Expected: `config/settings.schema.json` aliases 三处变为 `anyOf`（string | object），model 级新增 `flat`。

- [ ] **Step 8: typecheck + 全量测试（行为等价）**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（类型迁移 + 字面量已适配，行为等价）。

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/index.ts src/providers/model-types.ts src/routing.ts src/providers/models.ts src/cli/models/list.ts config/settings.schema.json test/config.test.ts test/routing.test.ts test/server/models-endpoint.test.ts test/codex-catalog.test.ts test/providers/models.test.ts test/providers/enumerate-models.test.ts
git commit -m "refactor(aliases): migrate aliases to AliasEntry union + add model.flat (behavior-equivalent)"
```

---

## Task 2: enumerateModelEntries ids 构建（新语义）

**Files:**
- Modify: `src/providers/model-types.ts:27-73`（`ModelEntry` 移除 `flat` 加 `modelFlat`，ids 重写）
- Modify: `src/routing.ts:63`（`entry.flat` → `entry.modelFlat`，过渡）
- Modify: `src/cli/models/list.ts:16,27`（`ModelRow.flat` → `modelFlat`）
- Test: `test/providers/enumerate-models.test.ts`、`test/providers/models.test.ts`、`test/server/models-endpoint.test.ts`、`test/codex-catalog.test.ts`

**Note（中间态）:** 本任务提交后、Task 3 前，`listModels`/codex 会列出裸名 alias（ids 含裸名），但 `routing.resolve` 仍是旧逻辑（仅 `modelFlat` 时注册裸名、未命中抛 `flat_lookup_disabled`）。即"`/v1/models` 列出裸名 alias 但请求该裸名路由失败"的暂态，Task 3 修复。本任务测试只断言 `enumerateModelEntries` 的 ids，不碰 resolve，故能绿。

**Interfaces:**
- Produces: `ModelEntry.modelFlat: boolean`（= `isFlatLookupEnabled(provider) || model.flat`）；新 ids 顺序 `[provider/modelKey, ?modelKey, ...flatMap(alias => [provider/name, ?name])]`。

- [ ] **Step 1: 写失败测试（ids 顺序新期望）**

追加到 `test/providers/enumerate-models.test.ts`。**复用该文件已有的本地 `makeSettings(providers, enableFlatModelLookup=false)`**（`:5`，不 import helper）：

```ts
import type { AliasEntry, ModelRouteConfig } from '../../src/config.js'

const P = (models: Record<string, ModelRouteConfig>, flat = false) => ({
  type: 'openai-compatible' as const,
  baseURL: 'http://x',
  apiKey: 'k',
  headers: {},
  plugins: [],
  options: flat ? { enableFlatModelLookup: true } : undefined,
  models,
})
const M = (upstreamModel: string, aliases: AliasEntry[] = [], flat = false): ModelRouteConfig => ({
  upstreamModel,
  aliases,
  flat,
  headers: {},
  plugins: [],
})

describe('enumerateModelEntries ids (new semantics)', () => {
  it('flat off + 1 string alias → [p/m, p/a]', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }]) }) })
    const e = enumerateModelEntries(s).find((x) => x.modelKey === 'm')!
    expect(e.ids).toEqual(['p/m', 'p/a'])
    expect(e.modelFlat).toBe(false)
  })

  it('flat on + 2 string alias → [p/m, m, p/a1, a1, p/a2, a2]', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a1', flat: false }, { name: 'a2', flat: false }]) }, true) })
    const e = enumerateModelEntries(s).find((x) => x.modelKey === 'm')!
    expect(e.ids).toEqual(['p/m', 'm', 'p/a1', 'a1', 'p/a2', 'a2'])
    expect(e.modelFlat).toBe(true)
  })

  it('flat off + record alias {flat:true} → [p/m, p/a, a]', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: true }]) }) })
    const e = enumerateModelEntries(s).find((x) => x.modelKey === 'm')!
    expect(e.ids).toEqual(['p/m', 'p/a', 'a'])
    expect(e.modelFlat).toBe(false)
  })

  it('model.flat=true (provider flat off) → [p/m, m, p/a, a]', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }], true) }) })
    const e = enumerateModelEntries(s).find((x) => x.modelKey === 'm')!
    expect(e.ids).toEqual(['p/m', 'm', 'p/a', 'a'])
    expect(e.modelFlat).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/providers/enumerate-models.test.ts`
Expected: FAIL（`modelFlat` 不存在，ids 旧顺序）

- [ ] **Step 3: 实现 — `src/providers/model-types.ts`**

`ModelEntry`（`:33-41`）：移除 `flat`，加 `modelFlat`：
```ts
export interface ModelEntry {
  providerName: string
  modelKey: string
  upstreamModel: string
  aliases: AliasEntry[]
  limit: ModelLimit | undefined
  modelFlat: boolean
  ids: string[]
}
```
更新顶部注释（`:27-32`）为新 ids 顺序：`[provider/modelKey, ...(modelFlat ? [modelKey] : []), ...flatMap(alias => [provider/alias.name, ...(modelFlat||alias.flat ? [alias.name] : [])])]`，`modelFlat = isFlatLookupEnabled(provider) || model.flat`。

重写 ids 构建（`:52-69`）：
```ts
    const providerFlat = isFlatLookupEnabled(provider, settings)
    const modelFlat = providerFlat || !!model.flat
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const ids: string[] = [`${providerName}/${modelKey}`]
      if (modelFlat) {
        ids.push(modelKey)
      }
      for (const alias of model.aliases) {
        ids.push(`${providerName}/${alias.name}`)
        if (modelFlat || alias.flat) {
          ids.push(alias.name)
        }
      }
      entries.push({
        providerName,
        modelKey,
        upstreamModel: model.upstreamModel,
        aliases: [...model.aliases],
        limit: model.limit,
        modelFlat,
        ids,
      })
    }
```

- [ ] **Step 4: 适配 `entry.flat` → `entry.modelFlat`**

`src/routing.ts:63`：`if (entry.flat)` → `if (entry.modelFlat)`（过渡，Task 3 再改 per-alias 裸名注册）。
`src/cli/models/list.ts`：`ModelRow.flat` → `modelFlat: boolean`（`:16`），`collectRows` `flat: entry.flat` → `modelFlat: entry.modelFlat`（`:27`）。

- [ ] **Step 5: 更新 ids 顺序断言（4 个测试文件）**

按新规则更新现有用例期望（带前缀入口始终有；裸名 = modelFlat || alias.flat）。完整对照（文件:行 → 旧 → 新）：

| 位置 | 旧 ids | 新 ids |
|---|---|---|
| `models.test.ts:101-105`（flat on + alias `default`） | `['openrouter/chat','chat','default']` | `['openrouter/chat','chat','openrouter/default','default']` |
| `enumerate-models.test.ts:87`（flat on + `default,fast`） | `['openrouter/chat','chat','default','fast']` | `['openrouter/chat','chat','openrouter/default','default','openrouter/fast','fast']` |
| `enumerate-models.test.ts:118-123`（per-provider：openrouter flat on + `a1`；deepseek flat off + `a2`） | `['openrouter/chat','chat','a1']` / `['deepseek/coder']` | `['openrouter/chat','chat','openrouter/a1','a1']` / `['deepseek/coder','deepseek/a2']` |
| `models-endpoint.test.ts:109-113`（flat on + `default`） | `['openrouter/chat','chat','default']` | `['openrouter/chat','chat','openrouter/default','default']` |
| `models-endpoint.test.ts:116-128`（flat off + `default`） | `['openrouter/chat']` | `['openrouter/chat','openrouter/default']` |
| `models-endpoint.test.ts:262-267`（per-provider flat on + `default` + deepseek `reasoner` 无 alias） | 4 元素 | `['openrouter/chat','chat','openrouter/default','default','deepseek/reasoner']` |
| `models-endpoint.test.ts:372-377`（flat on + `default` + limit） | 3 元素 | `['openrouter/chat','chat','openrouter/default','default']` |
| `codex-catalog.test.ts:147`（flat off + alias `g`，`.sort()`） | `['zhipu/glm-5.1']` | `['zhipu/g', 'zhipu/glm-5.1']` |
| `codex-catalog.test.ts:183`（flat on + `g`，`.sort()`） | `['g','glm-5.1','zhipu/glm-5.1']` | `['g','glm-5.1','zhipu/g','zhipu/glm-5.1']` |

逐用例按表修改期望值，保留断言结构；行号为参考，实现时以实际为准。

另外 `test/codex-catalog.test.ts` 补一条断言：`provider/<alias>` slug 的 `context_window` 与主 slug 一致（同 `entry.limit`），覆盖 spec §测试的 limit 共享要求。

- [ ] **Step 6: 运行测试验证通过**

Run: `pnpm test test/providers/enumerate-models.test.ts test/providers/models.test.ts test/server/models-endpoint.test.ts test/codex-catalog.test.ts`
Expected: PASS

- [ ] **Step 7: 全量 typecheck + test**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 8: Commit**

```bash
git add src/providers/model-types.ts src/routing.ts src/cli/models/list.ts test/providers/enumerate-models.test.ts test/providers/models.test.ts test/server/models-endpoint.test.ts test/codex-catalog.test.ts
git commit -m "feat(aliases): new ids semantics with model.flat/alias.flat and prefixed entries"
```

---

## Task 3: 路由构造期检测与 resolve 适配

**Files:**
- Modify: `src/routing.ts:46-148`（`fromSettings` 裸名注册 + ambiguous + 带前缀唯一性；`resolve` 裸名分支移除 `anyFlatEnabled`/`flat_lookup_disabled`）
- Test: `test/routing.test.ts`

**Note（保留现有测试）:** `test/routing.test.ts` 的 `describe('RoutingTable')` 块含 route 数据合并、plugin 覆盖、PluginRegistry 注入等**非 flat 用例**（约 line 33-44、169-189），与本次无关，**必须保留不动**。仅删除/重写其中 flat 相关用例（`rejects flat lookup when disabled`、`resolves flat aliases when enabled`、ambiguous、per-provider、跨 provider、`flat_lookup_disabled`/`unknown_model`），新增的冲突/带前缀用例可放入同一 describe。

**Interfaces:**
- Produces: `fromSettings` 构造期抛 `ambiguous flat route '<selector>'`（裸名冲突）与 `duplicate model selector '<name>' in provider '<p>'`（带前缀唯一性冲突，provider 级）；`resolve` 裸名未命中抛 `unknown_model`。

- [ ] **Step 1: 写失败测试**

`test/routing.test.ts` 已 import helper `makeSettings`（`:4`）。改写 flat 用例、新增冲突用例（错误文案用正则子串匹配，非精确）：

```ts
import type { AliasEntry, ModelRouteConfig } from '../src/config.js'

const P = (models: Record<string, ModelRouteConfig>, flat = false) => ({
  type: 'openai-compatible' as const,
  baseURL: 'http://x',
  apiKey: 'k',
  headers: {},
  plugins: [],
  options: flat ? { enableFlatModelLookup: true } : undefined,
  models,
})
const M = (upstreamModel: string, aliases: AliasEntry[] = [], flat = false): ModelRouteConfig => ({
  upstreamModel, aliases, flat, headers: {}, plugins: [],
})

describe('RoutingTable flat/alias resolution', () => {
  it('resolves provider/<alias> prefixed entry without flat', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }]) }) })
    expect(RoutingTable.fromSettings(s).resolve('p/a').modelKey).toBe('m')
  })

  it('resolves record alias flat:true naked name without provider flat', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: true }]) }) })
    expect(RoutingTable.fromSettings(s).resolve('a').modelKey).toBe('m')
  })

  it('naked name miss returns unknown_model (no flat_lookup_disabled)', () => {
    const s = makeSettings({ p: P({ m: M('up', []) }) })
    expect(() => RoutingTable.fromSettings(s).resolve('nope')).toThrow(/unknown_model/)
  })

  it('rejects ambiguous naked alias across providers (both alias.flat)', () => {
    const mk = (flat: boolean) => P({ m: M('up', [{ name: 'shared', flat }]) })
    const s = makeSettings({ p1: mk(true), p2: mk(true) })
    expect(() => RoutingTable.fromSettings(s)).toThrow(/ambiguous flat route 'shared'/)
  })

  it('rejects duplicate prefixed selector: alias name == modelKey', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'm', flat: false }]) }) })
    expect(() => RoutingTable.fromSettings(s)).toThrow(/duplicate model selector 'm' in provider 'p'/)
  })

  it('rejects duplicate prefixed selector: same alias name across models in same provider', () => {
    const s = makeSettings({ p: P({ m1: M('up', [{ name: 'fast', flat: false }]), m2: M('up', [{ name: 'fast', flat: false }]) }) })
    expect(() => RoutingTable.fromSettings(s)).toThrow(/duplicate model selector 'fast' in provider 'p'/)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/routing.test.ts`
Expected: FAIL（`p/a` 未注册；`flat_lookup_disabled` 仍抛；无唯一性检测）

- [ ] **Step 3: 实现 `fromSettings`（`src/routing.ts:46-74`）**

`prefixed` Set 提到循环外，key = `${providerName}/${name}`（provider 级唯一，跨 model 检测，不同 provider 不误报）：

```ts
  static fromSettings(settings: Settings, pluginRegistry?: PluginRegistry): RoutingTable {
    const flatRoutes = new Map<string, RouteMatch>()
    const prefixed = new Set<string>()

    for (const entry of enumerateModelEntries(settings)) {
      const provider = settings.providers[entry.providerName]
      if (!provider) continue
      const route = buildRoute(
        entry.providerName,
        provider,
        entry.modelKey,
        `${entry.providerName}/${entry.modelKey}`,
        pluginRegistry,
      )

      // 带前缀入口唯一性:同 provider 内 {modelKey} ∪ {alias name} 全局唯一
      const assertPrefixedUnique = (name: string) => {
        const key = `${entry.providerName}/${name}`
        if (prefixed.has(key)) {
          throw new Error(`duplicate model selector '${name}' in provider '${entry.providerName}'`)
        }
        prefixed.add(key)
      }
      assertPrefixedUnique(entry.modelKey)
      for (const alias of entry.aliases) {
        assertPrefixedUnique(alias.name)
      }

      // 裸名入口注册 + ambiguous 检测(flatRoutes 跨 provider 全局)
      const registerBare = (selector: string) => {
        if (flatRoutes.has(selector)) {
          throw new Error(`ambiguous flat route '${selector}' is configured`)
        }
        flatRoutes.set(selector, route)
      }
      if (entry.modelFlat) {
        registerBare(entry.modelKey)
      }
      for (const alias of entry.aliases) {
        if (entry.modelFlat || alias.flat) {
          registerBare(alias.name)
        }
      }
    }

    return new RoutingTable(settings, flatRoutes, pluginRegistry)
  }
```

- [ ] **Step 4: 实现 `resolve` 裸名分支（`src/routing.ts:86-110`）**

移除 `anyFlatEnabled` 前置检查与 `flat_lookup_disabled`：

```ts
    if (!selector.includes('/')) {
      const route = this.flatRoutes.get(selector)
      if (!route) {
        throw new RoutingError(404, 'unknown_model', selector, 'No model route matched requested model selector')
      }
      return route
    }
```

provider/model 分支（`:132-140`）已在 Task 1 适配，不变。

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test test/routing.test.ts`
Expected: PASS

- [ ] **Step 6: 全量 typecheck + test**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（旧 `flat_lookup_disabled` 断言已改 `unknown_model`）

- [ ] **Step 7: Commit**

```bash
git add src/routing.ts test/routing.test.ts
git commit -m "feat(routing): per-alias/model flat registration, prefixed uniqueness, drop flat_lookup_disabled"
```

---

## Task 4: getModel 两分支适配

**Files:**
- Modify: `src/providers/models.ts:20-57`（`getModel` slashIndex 补 alias；扁平分支 flat 判定改 `modelFlat || alias.flat`）
- Test: `test/providers/models.test.ts`

**Interfaces:**
- Produces: `getModel` 支持 `provider/<alias-name>` 与 `model.flat`/`alias.flat` 裸名；返回 `id` 始终 = 入参。

- [ ] **Step 1: 写失败测试**

追加到 `test/providers/models.test.ts`。**复用该文件已有的本地 `makeSettings(providers, enableFlatModelLookup=false)`**（`:5`，不 import helper）：

```ts
import type { AliasEntry, ModelRouteConfig } from '../../src/config.js'

const P = (models: Record<string, ModelRouteConfig>) => ({
  type: 'openai-compatible' as const, baseURL: 'http://x', apiKey: 'k', headers: {}, plugins: [], models,
})
const M = (upstreamModel: string, aliases: AliasEntry[] = [], flat = false): ModelRouteConfig => ({
  upstreamModel, aliases, flat, headers: {}, plugins: [],
})

describe('getModel alias/flat', () => {
  it('resolves provider/<alias> via slash branch', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }]) }) })
    expect(getModel(s, 'p/a')?.id).toBe('p/a')
  })

  it('resolves naked alias via model.flat (provider flat off)', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }], true) }) })
    expect(getModel(s, 'a')?.id).toBe('a')
    expect(getModel(s, 'm')?.id).toBe('m')
  })

  it('resolves naked record alias flat:true (provider/model flat off)', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: true }]) }) })
    expect(getModel(s, 'a')?.id).toBe('a')
  })

  it('returns null for naked name when no flat enabled', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }]) }) })
    expect(getModel(s, 'a')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/providers/models.test.ts`
Expected: FAIL（`p/a` 返回 null；`model.flat` 裸名返回 null）

- [ ] **Step 3: 实现 `getModel`（`src/providers/models.ts:20-57`）**

slashIndex 分支（`:24-38`）补 alias 遍历：
```ts
  if (slashIndex > 0) {
    const providerName = modelId.slice(0, slashIndex)
    const requestedModel = modelId.slice(slashIndex + 1)
    if (!requestedModel) return null

    const provider = settings.providers[providerName]
    if (provider?.models[requestedModel]) {
      return makeModel(modelId, providerName, provider.models[requestedModel].limit)
    }
    for (const model of Object.values(provider?.models ?? {})) {
      if (model.aliases.some((a) => a.name === requestedModel)) {
        return makeModel(modelId, providerName, model.limit)
      }
    }
    return null
  }
```

扁平分支（`:40-54`）flat 判定改 `providerFlat || model.flat`（modelKey）/ `|| alias.flat`（alias）：
```ts
  for (const [providerName, provider] of Object.entries(settings.providers)) {
    const providerFlat = isFlatLookupEnabled(provider, settings)
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const modelFlat = providerFlat || !!model.flat
      if (modelFlat && modelKey === modelId) {
        return makeModel(modelId, providerName, model.limit)
      }
      if (model.aliases.some((a) => (modelFlat || a.flat) && a.name === modelId)) {
        return makeModel(modelId, providerName, model.limit)
      }
    }
  }
  return null
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test test/providers/models.test.ts`
Expected: PASS

- [ ] **Step 5: 全量 typecheck + test**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/providers/models.ts test/providers/models.test.ts
git commit -m "feat(models): getModel supports prefixed alias and model.flat/alias.flat naked lookup"
```

---

## Task 5: models list 多行垂直居中渲染

**Files:**
- Modify: `src/cli/models/list.ts:11-104`（`ModelRow` 一行一模型、`collectRows` 不再按 ids 展开、新增 `renderRows` 纯函数 + `formatTable` 调用它）
- Test: `test/cli/models/list.test.ts`（新建）

**Interfaces:**
- Produces: 导出 `renderRows(rows: ModelRow[]): string[]`（纯函数，返回含表头/分隔线/数据行的所有物理行）、`ModelRow`、`formatLimitNum`（既有）。`formatTable` 调 `renderRows` 并 `console.log`。

- [ ] **Step 1: 写失败测试（更新既有 `test/cli/models-list.test.ts`）**

该文件已存在并测 `formatLimitNum`（import `../../src/cli/models/list.js`）。**追加** `renderRows` 用例，不新建文件。注意：aliases 后还有 context/input/output 三列，alias 值经 padEnd 后不在行尾，故**不用 `$` 锚定**：

```ts
import { describe, it, expect } from 'vitest'
import { renderRows, formatLimitNum } from '../../src/cli/models/list.js'
import type { ModelRow } from '../../src/cli/models/list.js'

describe('formatLimitNum', () => {
  it('formats undefined/-/K/M/plain', () => {
    expect(formatLimitNum(undefined)).toBe('-')
    expect(formatLimitNum(0)).toBe('0')
    expect(formatLimitNum(2048)).toBe('2K')
    expect(formatLimitNum(1048576)).toBe('1M')
    expect(formatLimitNum(1500)).toBe('1500')
  })
})

describe('renderRows', () => {
  const row = (overrides: Partial<ModelRow> = {}): ModelRow => ({
    id: 'p/m', provider: 'p', upstreamModel: 'up',
    aliases: [], modelFlat: false, limit: undefined, ...overrides,
  })

  it('empty aliases → single data row with "-" in Aliases', () => {
    const lines = renderRows([row()])
    expect(lines[0]).toContain('ID')
    expect(lines[1]).toMatch(/─/)
    expect(lines[2]).toContain('p/m')
    expect(lines[2]).toContain('-')
    expect(lines).toHaveLength(3)
  })

  it('3 aliases (one bare) → 3 data rows, single-value cols vertically centered on middle row, * on bare', () => {
    const lines = renderRows([row({
      aliases: [
        { name: 'a1', flat: false },
        { name: 'a2', flat: true },
        { name: 'a3', flat: false },
      ],
      modelFlat: false,
    })])
    expect(lines).toHaveLength(5) // header + sep + 3 data rows
    const top = 1 // floor((3-1)/2)
    const dataStart = 2
    // 单值列只在中间行(top)出现 'p/m',其余行不含
    expect(lines[dataStart + 0]).not.toMatch(/p\/m/)
    expect(lines[dataStart + top]).toMatch(/p\/m/)
    expect(lines[dataStart + 2]).not.toMatch(/p\/m/)
    // alias 列:a1 / a2 * / a3(aliases 非末列,不用 $ 锚定)
    expect(lines[dataStart + 0]).toMatch(/a1/)
    expect(lines[dataStart + 1]).toMatch(/a2 \*/)
    expect(lines[dataStart + 2]).toMatch(/a3/)
    // a1 行不应出现 a2/a3,避免误匹配
    expect(lines[dataStart + 0]).not.toMatch(/a2/)
    expect(lines[dataStart + 2]).not.toMatch(/a2/)
  })

  it('model.flat=true marks all aliases bare', () => {
    const lines = renderRows([row({ aliases: [{ name: 'a', flat: false }], modelFlat: true })])
    expect(lines[2]).toMatch(/a \*/)
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/cli/models/list.test.ts`
Expected: FAIL（`renderRows`/`ModelRow` 未导出）

- [ ] **Step 3: 实现 `ModelRow` + `collectRows` + `renderRows`（`src/cli/models/list.ts`）**

替换 `:11-31`：
```ts
export interface ModelRow {
  id: string
  provider: string
  upstreamModel: string
  aliases: AliasEntry[]
  modelFlat: boolean
  limit: ModelRouteConfig['limit']
}

function collectRows(settings: Settings): ModelRow[] {
  return enumerateModelEntries(settings).map((entry) => ({
    id: `${entry.providerName}/${entry.modelKey}`,
    provider: entry.providerName,
    upstreamModel: entry.upstreamModel,
    aliases: entry.aliases,
    modelFlat: entry.modelFlat,
    limit: entry.limit ?? undefined,
  }))
}
```

替换 `formatTable`（`:41-104`）为 `renderRows` + `formatTable`：
```ts
const ROW_COL_DEFS = [
  { key: 'id', header: 'ID', align: 'left' as const },
  { key: 'provider', header: 'Provider', align: 'left' as const },
  { key: 'upstreamModel', header: 'Upstream Model', align: 'left' as const },
  { key: 'aliases', header: 'Aliases', align: 'left' as const },
  { key: 'context', header: 'Context', align: 'right' as const },
  { key: 'input', header: 'Input', align: 'right' as const },
  { key: 'output', header: 'Output', align: 'right' as const },
]

interface Prepared {
  single: Record<string, string>
  aliasLines: string[]
  H: number
}

function prepare(rows: ModelRow[]): Prepared[] {
  return rows.map((r) => {
    const single: Record<string, string> = {
      id: r.id,
      provider: r.provider,
      upstreamModel: r.upstreamModel,
      context: formatLimitNum(r.limit?.context),
      input: formatLimitNum(r.limit?.input),
      output: formatLimitNum(r.limit?.output),
    }
    const aliasLines =
      r.aliases.length === 0
        ? ['-']
        : r.aliases.map((a) => (r.modelFlat || a.flat ? `${a.name} *` : a.name))
    return { single, aliasLines, H: Math.max(1, r.aliases.length) }
  })
}

export function renderRows(rows: ModelRow[]): string[] {
  const lines: string[] = []
  if (rows.length === 0) return lines

  const prepared = prepare(rows)
  const widths = new Map<string, number>()
  for (const col of ROW_COL_DEFS) {
    let max = col.header.length
    for (const p of prepared) {
      if (col.key === 'aliases') {
        max = Math.max(max, ...p.aliasLines.map((t) => t.length))
      } else {
        max = Math.max(max, (p.single[col.key] ?? '').length)
      }
    }
    widths.set(col.key, max)
  }

  const pad = (value: string, col: (typeof ROW_COL_DEFS)[number]): string => {
    const width = widths.get(col.key) ?? 0
    return col.align === 'right' ? value.padStart(width) : value.padEnd(width)
  }

  lines.push(ROW_COL_DEFS.map((c) => c.header.padEnd(widths.get(c.key) ?? 0)).join('  '))
  lines.push(ROW_COL_DEFS.map((c) => '─'.repeat(widths.get(c.key) ?? 0)).join('  '))

  for (const p of prepared) {
    const top = Math.floor((p.H - 1) / 2) // 单值列垂直居中行
    for (let i = 0; i < p.H; i++) {
      lines.push(
        ROW_COL_DEFS.map((c) => {
          if (c.key === 'aliases') return pad(p.aliasLines[i] ?? '', c)
          return pad(i === top ? (p.single[c.key] ?? '') : '', c)
        }).join('  '),
      )
    }
  }
  return lines
}

function formatTable(rows: ModelRow[]): void {
  if (rows.length === 0) {
    console.log('No models configured in settings.')
    return
  }
  for (const line of renderRows(rows)) console.log(line)
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test test/cli/models/list.test.ts`
Expected: PASS

- [ ] **Step 5: 全量 typecheck + test**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/cli/models/list.ts test/cli/models/list.test.ts
git commit -m "feat(cli): models list one-row-per-model with multi-line vertically-centered aliases"
```

---

## Task 6: 端到端验证与收尾

**Files:** 无新增改动文件；验证 + schema 一致性收尾。

- [ ] **Step 1: schema 一致性**

Run: `pnpm generate:schema && git diff --stat config/settings.schema.json`
Expected: 无意外差异（Task 1 已生成；若 Task 1-5 间 schema 字段再变则重新生成）。

- [ ] **Step 2: 全量 typecheck + test**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 3: 启动服务验证路由**

Run: `pnpm dev serve --no-watch`（后台）
用 `curl` 请求 `provider/<alias>` 与裸名 alias（配置含 `model.flat` 或 `alias.flat` 的 provider），确认命中同一 `upstreamModel`。

- [ ] **Step 4: 验证 models list 渲染**

Run: `pnpm dev models list`
Expected: 一行一模型；多 alias 模型行多行显示且单值列垂直居中；有裸名入口的 alias 带 `*`。

- [ ] **Step 5: 停止服务，最终 commit（若有收尾改动）**

```bash
git add config/settings.schema.json
git commit -m "chore(schema): regenerate settings schema for aliases flat" --allow-empty
```

---

## Self-Review

**Spec coverage:** §1→Task 1；§2→Task 2；§3→Task 3；§4→Task 4；§5→Task 5；§6→Task 1/6；§测试→Task 1-5；§Breaking→各 Task。

**Placeholder scan:** 无 TBD/TODO；测试与实现代码完整。

**Type consistency:** `AliasEntry`（Task 1）→ `ModelEntry.aliases`（Task 2）、routing/models/list 消费一致；`modelFlat`（Task 2）→ routing/list（Task 2/5）一致；`renderRows`/`ModelRow`（Task 5）测试与实现一致；错误文案 `duplicate model selector`/`ambiguous flat route` 与测试正则一致；`P`/`M` helper 在 Task 2/3/4 一致（含 `headers`/`plugins`）。

**Round-1 fixes:** ① Task 1 改非空 alias 字面量为 object 形式；② Task 3 `prefixed` Set 提循环外、key=`provider/name`；③ codex-catalog 路径 `test/codex-catalog.test.ts`；④ Task 5 新增 `renderRows` + 测试；⑤ Task 2 Step 5 ids 对照；⑥ 新测试用 `makeSettings`。

**Round-2 fixes:** ⑦ Task 5 测试去 `$` 锚定（aliases 非末列）+ 加 `not.toMatch(/a2/)` 防误匹配；⑧ Task 2/3/4 `P`/`M` helper 补 `headers`/`plugins`（`.default` 后必填）；⑨ 复用各文件本地 `makeSettings`（Task 2/4）/helper `makeSettings`（Task 3，已 import），不引入同名冲突；⑩ Task 3 声明保留非 flat 测试；⑪ Task 2 Step 5 补全 9 处 ids 对照表；⑫ Task 2 声明 list/routing 中间态暂态。
