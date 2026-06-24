# /codex/v1/models codex ModelsResponse 格式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/codex/v1/models` 响应从 OpenAI 格式改为 codex `ModelsResponse`(`{models:[<ModelInfo>]}`),懒加载 `codex debug models --bundled` 缓存整个 catalog 作 template 源,支持 4 层配置覆盖(默认/全局/provider/model),`templateSlug` 与所有字段(除 `slug`)可覆盖。

**Architecture:** 新增 `src/server/codex-catalog.ts`(catalog 获取+缓存、4 层合并、类型);`src/config.ts` 加 `codexModelInfoSchema`/`codexModelOverrideSchema` 挂到 `settings.codex`/`provider.options.codex`/`model.codex`;`src/server/codex.ts` 的 `/v1/models` handler 改为返回 codex 格式。slug 固定 = listModels id;context_window = `limit.context` ?? 200000;失败 503。

**Tech Stack:** Hono v4.12、Zod v4、TypeScript(ESM + NodeNext,`.js` 扩展名)、Vitest、`node:child_process`。

## Global Constraints

- 所有本地导入用 `.js` 扩展名(ESM + NodeNext);type-only 导入用 `import type`(verbatimModuleSyntax)
- `tsconfig`:noUncheckedIndexedAccess、exactOptionalPropertyTypes、noImplicitOverride、verbatimModuleSyntax
- 入参/返回禁 `unknown`(除 JSON 解析/脱敏/透传例外);catalog 条目来自外部 JSON,用 Zod schema 解析为具体类型
- 测试 Vitest 无网络;`codex debug models --bundled` 全程 mock,不依赖真实 codex CLI
- `slug` 固定 = listModels id,不可覆盖(`CodexModelOverride` 不含 `slug`)
- `context_window`/`max_context_window` = `limit.context` ?? `200000`
- `templateSlug` 默认 `"gpt-5.4"`,4 层都可覆盖,合并后决定每模型 template 源
- 合并顺序:合并 templateSlug → 取 template → settings 推导默认 → 全局→provider→model 字段覆盖(浅合并,嵌套对象整体替换)
- 任一模型 templateSlug 不在 catalog → 整个响应 503
- 命令:`pnpm test`、`pnpm test test/server/codex-catalog.test.ts`、`pnpm typecheck`
- commit 需用户审批;分支 `main`

---

### Task 1: codex schema + config 三层挂载

**Files:**
- Modify: `src/config.ts`(加 `codexModelInfoSchema`/`codexModelOverrideSchema`/类型;挂到 `settings.codex`、`commonProviderOptionsSchema.codex`、`modelRouteConfigSchema.codex`)
- Create: `test/server/codex-config.test.ts`

**Interfaces:**
- Produces: `codexModelInfoSchema`、`codexModelOverrideSchema`、`CodexModelInfo`、`CodexModelOverride`(均从 `../config.js` 导出);`settings.codex`/`provider.options.codex`/`model.codex` 可选字段

- [ ] **Step 1: Write the failing test**

Create `test/server/codex-config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { settingsSchema } from '../../src/config.js'

describe('codex config mounting', () => {
  it('parses codex override at settings / provider / model scope', () => {
    const settings = settingsSchema.parse({
      codex: { templateSlug: 'gpt-5.5', default_reasoning_level: 'medium' },
      providers: {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          options: { codex: { context_window: 128000, max_context_window: 128000 } },
          models: {
            'glm-5.1': { upstreamModel: 'glm-5.1', codex: { display_name: 'GLM-5.1' } },
          },
        },
      },
    })
    expect(settings.codex?.templateSlug).toBe('gpt-5.5')
    expect(settings.codex?.default_reasoning_level).toBe('medium')
    expect(settings.providers.zhipu?.options?.codex?.context_window).toBe(128000)
    expect(settings.providers.zhipu?.models['glm-5.1']?.codex?.display_name).toBe('GLM-5.1')
  })

  it('codex is optional and slug override is stripped (not in schema)', () => {
    const settings = settingsSchema.parse({
      providers: {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          models: { 'glm-5.1': { upstreamModel: 'glm-5.1', codex: { slug: 'x' } } },
        },
      },
    })
    expect(settings.codex).toBeUndefined()
    expect(settings.providers.zhipu?.models['glm-5.1']?.codex?.slug).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/server/codex-config.test.ts`
Expected: FAIL — `settings.codex` undefined(字段未挂载),或 zod 报 `codex` 未知字段(strict)。

- [ ] **Step 3: Add codex schemas to `src/config.ts`**

在 `modelRouteConfigSchema`(line 48)定义**之前**插入 codex 字段 schema(被 `modelRouteConfigSchema` 引用):

```typescript
const codexReasoningLevelSchema = z.object({
  effort: z.string(),
  description: z.string().optional(),
}).passthrough()

const codexModelMessagesSchema = z.object({
  instructions_template: z.string(),
  instructions_variables: z.object({
    personality_default: z.string(),
    personality_friendly: z.string().optional(),
    personality_pragmatic: z.string().optional(),
  }).passthrough(),
}).passthrough()

const codexTruncationPolicySchema = z.object({
  mode: z.string(),
  limit: z.number(),
}).passthrough()

/** codex bundled catalog 条目(解析 codex 输出,宽松 passthrough 容忍 codex 新增字段) */
export const codexModelInfoSchema = z.object({
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable().optional(),
  default_reasoning_level: z.string().nullable().optional(),
  supported_reasoning_levels: z.array(codexReasoningLevelSchema),
  shell_type: z.string(),
  visibility: z.string(),
  supported_in_api: z.boolean(),
  priority: z.number(),
  additional_speed_tiers: z.array(z.string()).optional(),
  service_tiers: z.array(z.record(z.string(), z.unknown())).optional(),
  default_service_tier: z.string().nullable().optional(),
  availability_nux: z.record(z.string(), z.unknown()).nullable().optional(),
  upgrade: z.record(z.string(), z.unknown()).nullable().optional(),
  base_instructions: z.string(),
  model_messages: codexModelMessagesSchema.nullable().optional(),
  supports_reasoning_summaries: z.boolean(),
  default_reasoning_summary: z.string().optional(),
  support_verbosity: z.boolean(),
  default_verbosity: z.string().nullable().optional(),
  apply_patch_tool_type: z.string().nullable().optional(),
  web_search_tool_type: z.string().optional(),
  truncation_policy: codexTruncationPolicySchema,
  supports_parallel_tool_calls: z.boolean(),
  supports_image_detail_original: z.boolean().optional(),
  context_window: z.number().nullable().optional(),
  max_context_window: z.number().nullable().optional(),
  auto_compact_token_limit: z.number().nullable().optional(),
  comp_hash: z.string().nullable().optional(),
  effective_context_window_percent: z.number().optional(),
  experimental_supported_tools: z.array(z.record(z.string(), z.unknown())),
  input_modalities: z.array(z.string()).optional(),
  supports_search_tool: z.boolean().optional(),
  use_responses_lite: z.boolean().optional(),
  auto_review_model_override: z.string().nullable().optional(),
  tool_mode: z.string().nullable().optional(),
  multi_agent_version: z.string().nullable().optional(),
}).passthrough()

export type CodexModelInfo = z.infer<typeof codexModelInfoSchema>

/** 4 层覆盖用:templateSlug + 所有 ModelInfo 字段(除 slug),全可选 */
export const codexModelOverrideSchema = codexModelInfoSchema
  .omit({ slug: true })
  .partial()
  .extend({ templateSlug: z.string().min(1).optional() })

export type CodexModelOverride = z.infer<typeof codexModelOverrideSchema>
```

- [ ] **Step 4: Mount codex at three layers**

修改 `modelRouteConfigSchema`(line 48)加 `codex`:

```typescript
export const modelRouteConfigSchema = z.object({
  upstreamModel: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional().default([]),
  headers: z.record(z.string(), z.string()).optional().default({}),
  plugins: z.array(pluginEntrySchema).optional().default([]),
  limit: modelLimitSchema.optional(),
  codex: codexModelOverrideSchema.optional(),
})
```

修改 `commonProviderOptionsSchema`(line 68)加 `codex`:

```typescript
const commonProviderOptionsSchema = z.object({
  streamOnly: z.boolean().optional(),
  enableFlatModelLookup: z.boolean().optional(),
  codex: codexModelOverrideSchema.optional(),
})
```

修改 `settingsSchema`(line 131)加 `codex`(在 `providers` 之前):

```typescript
  codex: codexModelOverrideSchema.optional(),
  providers: z.record(z.string(), providerConfigSchema).default({}),
})
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test test/server/codex-config.test.ts`
Expected: PASS。

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add src/config.ts test/server/codex-config.test.ts
git commit -m "feat(codex): add codex ModelInfo/override schema + 3-layer config mounting"
```

---

### Task 2: catalog 获取 + 缓存(懒加载 + 并发去重)

**Files:**
- Create: `src/server/codex-catalog.ts`(catalog 获取 + 缓存部分;合并逻辑在 Task 3 加)
- Create: `test/server/codex-catalog.test.ts`

**Interfaces:**
- Consumes: `codexModelInfoSchema`、`CodexModelInfo`(from `../config.js`)
- Produces: `fetchCodexBundledCatalog(fetcher?: () => Promise<string>): Promise<Map<string, CodexModelInfo>>`、`CodexCatalogFetcher` 类型、`__resetCodexCatalogCacheForTest()`

- [ ] **Step 1: Write the failing test**

Create `test/server/codex-catalog.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import {
  fetchCodexBundledCatalog,
  __resetCodexCatalogCacheForTest,
} from '../../src/server/codex-catalog.js'

const FULL_MODEL = {
  slug: 'gpt-5.4',
  display_name: 'GPT-5.4',
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  base_instructions: 'x',
  supports_reasoning_summaries: false,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: false,
  experimental_supported_tools: [],
}

beforeEach(() => __resetCodexCatalogCacheForTest())

describe('fetchCodexBundledCatalog', () => {
  it('fetches, indexes by slug, caches (lazy + dedup concurrent)', async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      return JSON.stringify({ models: [FULL_MODEL] })
    }
    const [m1, m2] = await Promise.all([fetchCodexBundledCatalog(fetcher), fetchCodexBundledCatalog(fetcher)])
    const m3 = await fetchCodexBundledCatalog(fetcher)
    expect(calls).toBe(1)
    expect(m1).toBe(m2)
    expect(m1).toBe(m3)
    expect(m1.get('gpt-5.4')?.slug).toBe('gpt-5.4')
  })

  it('throws on non-json stdout', async () => {
    await expect(fetchCodexBundledCatalog(async () => 'not json')).rejects.toThrow()
  })

  it('throws on fetcher error', async () => {
    await expect(
      fetchCodexBundledCatalog(async () => {
        throw new Error('codex not found')
      }),
    ).rejects.toThrow('codex not found')
  })

  it('throws on entry missing slug', async () => {
    await expect(
      fetchCodexBundledCatalog(async () => JSON.stringify({ models: [{ ...FULL_MODEL, slug: undefined }] })),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/server/codex-catalog.test.ts`
Expected: FAIL — 模块不存在(import 失败)。

- [ ] **Step 3: Implement catalog fetch + cache**

Create `src/server/codex-catalog.ts`:

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { codexModelInfoSchema, type CodexModelInfo } from '../config.js'

const execFileAsync = promisify(execFile)

const codexCatalogSchema = z.object({
  models: z.array(codexModelInfoSchema),
})

export type CodexCatalogFetcher = () => Promise<string>

let cachedCatalog: Map<string, CodexModelInfo> | null = null
let inflight: Promise<Map<string, CodexModelInfo>> | null = null

async function defaultFetcher(): Promise<string> {
  const { stdout } = await execFileAsync('codex', ['debug', 'models', '--bundled'])
  return stdout
}

/** 懒加载获取 codex bundled catalog,按 slug 索引缓存;并发请求去重 */
export async function fetchCodexBundledCatalog(
  fetcher: CodexCatalogFetcher = defaultFetcher,
): Promise<Map<string, CodexModelInfo>> {
  if (cachedCatalog) return cachedCatalog
  if (inflight) return inflight
  inflight = (async () => {
    const stdout = await fetcher()
    const parsed = codexCatalogSchema.parse(JSON.parse(stdout))
    const map = new Map<string, CodexModelInfo>()
    for (const m of parsed.models) {
      if (!m.slug) throw new Error('codex catalog entry missing slug')
      map.set(m.slug, m)
    }
    cachedCatalog = map
    return map
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

/** 测试用:重置模块级缓存 */
export function __resetCodexCatalogCacheForTest(): void {
  cachedCatalog = null
  inflight = null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test test/server/codex-catalog.test.ts`
Expected: PASS(4 用例)。

- [ ] **Step 5: Commit**

```bash
git add src/server/codex-catalog.ts test/server/codex-catalog.test.ts
git commit -m "feat(codex): lazy-fetch + cache codex bundled catalog"
```

---

### Task 3: buildCodexModelsResponse(4 层合并)

**Files:**
- Modify: `src/server/codex-catalog.ts`(加 `buildCodexModelsResponse` + `enumerateModelEntries` + 合并)
- Modify: `test/server/codex-catalog.test.ts`(加合并用例)

**Interfaces:**
- Consumes: `Settings`、`CodexModelInfo`、`CodexModelOverride`(from `../config.js`)、`isFlatLookupEnabled`(from `../config-helpers.js`)、`ModelLimit`(from `../providers/model-types.js`)
- Produces: `buildCodexModelsResponse(settings: Settings, catalog: Map<string, CodexModelInfo>): { models: CodexModelInfo[] }`

- [ ] **Step 1: Write the failing tests**

在 `test/server/codex-catalog.test.ts` 末尾追加(保留现有 imports,补加):

```typescript
import { buildCodexModelsResponse } from '../../src/server/codex-catalog.js'
import { makeSettings } from '../helpers/settings.js'

const CATALOG = new Map<string, CodexModelInfo>([
  [
    'gpt-5.4',
    {
      ...FULL_MODEL,
      base_instructions: 'codex-base',
      model_messages: {
        instructions_template: 'tpl-{{ personality }}',
        instructions_variables: { personality_default: '' },
      },
      supports_parallel_tool_calls: false,
      context_window: 272000,
      max_context_window: 272000,
      visibility: 'hide',
      supported_in_api: false,
      priority: 9,
      experimental_supported_tools: [{ name: 'x' }],
    } as CodexModelInfo,
  ],
  [
    'gpt-5.5',
    { ...FULL_MODEL, slug: 'gpt-5.5', display_name: 'GPT-5.5', base_instructions: 'codex-5.5' },
  ],
])

import type { CodexModelInfo } from '../../src/config.js'

describe('buildCodexModelsResponse', () => {
  it('emits one ModelInfo per listModels id, slug fixed = id, settings-derived defaults', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        models: { 'glm-5.1': { upstreamModel: 'glm-5.1', aliases: ['g'], headers: {}, plugins: [] } },
      },
    })
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    // flat lookup 默认关闭:只 provider/modelKey
    expect(models.map((m) => m.slug).sort()).toEqual(['zhipu/glm-5.1'])
    const m = models[0]!
    expect(m.slug).toBe('zhipu/glm-5.1')
    expect(m.display_name).toBe('zhipu/glm-5.1') // 默认 = slug
    expect(m.context_window).toBe(200000) // 无 limit → fallback
    expect(m.max_context_window).toBe(200000)
    expect(m.visibility).toBe('list') // 强制,覆盖 template hide
    expect(m.supported_in_api).toBe(true)
    expect(m.priority).toBe(0)
    expect(m.experimental_supported_tools).toEqual([])
    expect(m.base_instructions).toBe('codex-base') // template
  })

  it('context_window from limit.context; flat lookup adds modelKey + alias slugs', () => {
    const settings = makeSettings(
      {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          headers: {},
          plugins: [],
          models: {
            'glm-5.1': {
              upstreamModel: 'glm-5.1',
              aliases: ['g'],
              headers: {},
              plugins: [],
              limit: { context: 128000 },
            },
          },
        },
      },
      { routing: { enableFlatModelLookup: true } },
    )
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    expect(models.map((m) => m.slug).sort()).toEqual(['g', 'glm-5.1', 'zhipu/glm-5.1'])
    const main = models.find((m) => m.slug === 'zhipu/glm-5.1')!
    expect(main.context_window).toBe(128000)
    expect(main.max_context_window).toBe(128000)
  })

  it('4-layer override merge: global < provider < model; templateSlug per-layer', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        options: { codex: { templateSlug: 'gpt-5.5', display_name: 'Zhipu Model' } },
        models: {
          'glm-5.1': {
            upstreamModel: 'glm-5.1',
            aliases: [],
            headers: {},
            plugins: [],
            codex: { display_name: 'GLM-5.1', supports_parallel_tool_calls: true },
          },
        },
      },
    })
    settings.codex = { default_reasoning_level: 'medium' }
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    const m = models[0]!
    expect(m.base_instructions).toBe('codex-5.5') // provider templateSlug=gpt-5.5 生效
    expect(m.display_name).toBe('GLM-5.1') // model 层覆盖 provider 层
    expect(m.supports_parallel_tool_calls).toBe(true) // model 层
    expect(m.default_reasoning_level).toBe('medium') // global 层
  })

  it('slug override in config is ignored (stripped)', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        models: {
          'glm-5.1': {
            upstreamModel: 'glm-5.1',
            aliases: [],
            headers: {},
            plugins: [],
            codex: { slug: 'should-be-ignored' } as never,
          },
        },
      },
    })
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    expect(models[0]!.slug).toBe('zhipu/glm-5.1')
  })

  it('throws when merged templateSlug not in catalog (whole response fails)', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        codex: { templateSlug: 'nonexistent' } as never,
        models: { 'glm-5.1': { upstreamModel: 'glm-5.1', aliases: [], headers: {}, plugins: [] } },
      },
    })
    expect(() => buildCodexModelsResponse(settings, CATALOG)).toThrow()
  })

  it('empty providers returns { models: [] }', () => {
    const { models } = buildCodexModelsResponse(makeSettings(), CATALOG)
    expect(models).toEqual([])
  })
})
```

> 注:`makeSettings(providers, options?)` 签名见 `test/helpers/settings.ts`;`settings.codex = {...}` 直接赋值因 `codex` 已挂载到 settingsSchema(zod 解析 makeSettings 后可赋可选字段)。

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/server/codex-catalog.test.ts`
Expected: FAIL — `buildCodexModelsResponse` 未定义。

- [ ] **Step 3: Implement buildCodexModelsResponse**

在 `src/server/codex-catalog.ts` 顶部 imports 加:

```typescript
import type { Settings, CodexModelOverride, CodexModelInfo } from '../config.js'
import { isFlatLookupEnabled } from '../config-helpers.js'
import type { ModelLimit } from '../providers/model-types.js'
```

在文件末尾(`__resetCodexCatalogCacheForTest` 之后)加:

```typescript
const DEFAULT_TEMPLATE_SLUG = 'gpt-5.4'
const DEFAULT_CONTEXT_WINDOW = 200000

interface ModelEntry {
  id: string
  providerName: string
  modelKey: string
  limit: ModelLimit | undefined
}

function enumerateModelEntries(settings: Settings): ModelEntry[] {
  const entries: ModelEntry[] = []
  for (const [providerName, provider] of Object.entries(settings.providers)) {
    const flatEnabled = isFlatLookupEnabled(provider, settings)
    for (const [modelKey, model] of Object.entries(provider.models)) {
      entries.push({ id: `${providerName}/${modelKey}`, providerName, modelKey, limit: model.limit })
      if (flatEnabled) {
        entries.push({ id: modelKey, providerName, modelKey, limit: model.limit })
        for (const alias of model.aliases) {
          entries.push({ id: alias, providerName, modelKey, limit: model.limit })
        }
      }
    }
  }
  return entries
}

function applyOverride(base: CodexModelInfo, override: NonNullable<CodexModelOverride>): CodexModelInfo {
  const result: CodexModelInfo = { ...base }
  for (const [k, v] of Object.entries(override)) {
    if (k === 'templateSlug' || k === 'slug' || v === undefined) continue
    ;(result as Record<string, unknown>)[k] = v
  }
  return result
}

function resolveTemplateSlug(settings: Settings, entry: ModelEntry): string {
  const provider = settings.providers[entry.providerName]
  const model = provider?.models[entry.modelKey]
  return (
    model?.codex?.templateSlug ??
    provider?.options?.codex?.templateSlug ??
    settings.codex?.templateSlug ??
    DEFAULT_TEMPLATE_SLUG
  )
}

/** 遍历 listModels id,按 4 层合并生成 codex ModelInfo[] */
export function buildCodexModelsResponse(
  settings: Settings,
  catalog: Map<string, CodexModelInfo>,
): { models: CodexModelInfo[] } {
  const models: CodexModelInfo[] = []
  for (const entry of enumerateModelEntries(settings)) {
    const provider = settings.providers[entry.providerName]
    const model = provider?.models[entry.modelKey]
    const templateSlug = resolveTemplateSlug(settings, entry)
    const template = catalog.get(templateSlug)
    if (!template) {
      throw new Error(`codex template slug not in catalog: ${templateSlug}`)
    }

    // 1. 基底 = template
    let info: CodexModelInfo = { ...template }
    // 2. settings 推导默认(slug 固定)
    info.slug = entry.id
    info.display_name = entry.id
    info.context_window = entry.limit?.context ?? DEFAULT_CONTEXT_WINDOW
    info.max_context_window = entry.limit?.context ?? DEFAULT_CONTEXT_WINDOW
    info.visibility = 'list'
    info.supported_in_api = true
    info.priority = 0
    info.experimental_supported_tools = []
    // 3. 三层覆盖 global → provider → model
    if (settings.codex) info = applyOverride(info, settings.codex)
    if (provider?.options?.codex) info = applyOverride(info, provider.options.codex)
    if (model?.codex) info = applyOverride(info, model.codex)

    models.push(info)
  }
  return { models }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/server/codex-catalog.test.ts`
Expected: PASS(全部用例,含 Task 2 的 4 个 + Task 3 的 6 个)。

- [ ] **Step 5: Commit**

```bash
git add src/server/codex-catalog.ts test/server/codex-catalog.test.ts
git commit -m "feat(codex): build ModelsResponse with 4-layer override merge"
```

---

### Task 4: /codex/v1/models handler 接入 + 503

**Files:**
- Modify: `src/server/types.ts`(AppDependencies 加 `codexCatalogFetcher?`)
- Modify: `src/server/app.ts`(createApp 透传 `codexCatalogFetcher` 给 createCodexApp)
- Modify: `src/server/codex.ts`(`/v1/models` handler 改 codex 格式 + 503)
- Modify: `test/server/codex-endpoint.test.ts`(`/codex/v1/models` 用例改断言 codex 格式)

**Interfaces:**
- Consumes: `fetchCodexBundledCatalog`、`buildCodexModelsResponse`(from `./codex-catalog.js`)
- Produces: `AppDependencies.codexCatalogFetcher?: () => Promise<string>`

- [ ] **Step 1: Replace the /codex/v1/models test**

在 `test/server/codex-endpoint.test.ts` 顶部 imports 加:

```typescript
import { __resetCodexCatalogCacheForTest } from './codex-catalog.js'
```

> 注:`codex-catalog.test.ts` 已 import `__resetCodexCatalogCacheForTest`,此处 test 文件在同目录 `test/server/`,import 路径 `./codex-catalog.js` 指向 `test/server/codex-catalog.test.ts`?不对——应 import 源模块。改为:

```typescript
import { __resetCodexCatalogCacheForTest, type CodexCatalogFetcher } from '../../src/server/codex-catalog.js'
```

把现有 `describe('GET /codex/v1/models', ...)` 整块替换为:

```typescript
const FULL_MODEL = {
  slug: 'gpt-5.4',
  display_name: 'GPT-5.4',
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  base_instructions: 'x',
  supports_reasoning_summaries: false,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: false,
  experimental_supported_tools: [],
}

const codexFetcher: CodexCatalogFetcher = async () =>
  JSON.stringify({ models: [FULL_MODEL] })

describe('GET /codex/v1/models', () => {
  beforeEach(() => __resetCodexCatalogCacheForTest())

  it('returns codex ModelsResponse with one entry per listModels id', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogFetcher: codexFetcher,
    })
    const res = await app.request('/codex/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.models).toHaveLength(1)
    expect(body.models[0].slug).toBe('openrouter/chat')
    expect(body.models[0].visibility).toBe('list')
    expect(body.models[0].supported_in_api).toBe(true)
  })

  it('injects x-request-id (middleware covers /codex)', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogFetcher: codexFetcher,
    })
    const res = await app.request('/codex/v1/models')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns 503 when codex fetch fails', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogFetcher: async () => {
        throw new Error('codex not installed')
      },
    })
    const res = await app.request('/codex/v1/models')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.message).toContain('codex not installed')
  })
})
```

并在文件顶部加 `import { beforeEach } from 'vitest'`(若未导入)。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/server/codex-endpoint.test.ts`
Expected: FAIL — `codexCatalogFetcher` 不在 AppDependencies,或 `/codex/v1/models` 仍返回 OpenAI 格式。

- [ ] **Step 3: Add codexCatalogFetcher to AppDependencies**

`src/server/types.ts` 的 `AppDependencies` 加字段:

```typescript
export interface AppDependencies {
  settings: Settings
  providerRegistry?: ProviderRegistry
  gateway?: ModelGateway
  logger?: pino.Logger
  tokenManager?: TokenManager
  nonce?: string
  authStatuses?: ProviderAuthStatus[]
  pluginRegistry?: PluginRegistry
  authFilePath?: string
  codexCatalogFetcher?: () => Promise<string>
}
```

- [ ] **Step 4: Thread fetcher through createApp → createCodexApp**

`src/server/app.ts` 的 `createApp` 调用处改为:

```typescript
  app.route('/codex', createCodexApp({ settings, protocolCtx, codexCatalogFetcher }))
```

- [ ] **Step 5: Rewrite /v1/models handler in codex.ts**

`src/server/codex.ts` 整体替换为:

```typescript
import { Hono } from 'hono'
import { openaiResponsesStrategy } from '../index.js'
import type { Settings } from '../index.js'
import { handleProtocolRequest } from './handle-protocol.js'
import type { ProtocolContext } from './handle-protocol.js'
import type { AppEnv } from './types.js'
import { buildCodexModelsResponse, fetchCodexBundledCatalog, type CodexCatalogFetcher } from './codex-catalog.js'

interface CodexAppDeps {
  settings: Settings
  protocolCtx: ProtocolContext
  codexCatalogFetcher?: CodexCatalogFetcher
}

export function createCodexApp(deps: CodexAppDeps): Hono<AppEnv> {
  const { settings, protocolCtx, codexCatalogFetcher } = deps
  const app = new Hono<AppEnv>()

  app.post('/v1/responses', (c) =>
    handleProtocolRequest(c, openaiResponsesStrategy, protocolCtx),
  )

  app.get('/v1/models', async (c) => {
    try {
      const catalog = await fetchCodexBundledCatalog(codexCatalogFetcher)
      return c.json(buildCodexModelsResponse(settings, catalog))
    } catch (err) {
      c.get('logger').error({ err }, 'codex /v1/models failed')
      const message = err instanceof Error ? err.message : String(err)
      return c.json(
        { error: { type: 'server_error', message: `Failed to fetch codex bundled catalog: ${message}` } },
        503,
      )
    }
  })

  return app
}
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm test test/server/codex-endpoint.test.ts && pnpm typecheck`
Expected: 测试 PASS;typecheck 无错。

- [ ] **Step 7: Commit**

```bash
git add src/server/codex.ts src/server/app.ts src/server/types.ts test/server/codex-endpoint.test.ts
git commit -m "feat(codex): return codex ModelsResponse from /codex/v1/models"
```

---

### Task 5: 全量测试 + 收尾

**Files:**
- Verify only

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: 全部通过(含原有 `/v1/*` 与 `/codex/v1/responses` 测试,无回归;新增 codex-config/codex-catalog/codex-endpoint 测试通过)。

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit spec & plan**

```bash
git add docs/superpowers/specs/2026-06-23-codex-models-format-design.md docs/superpowers/plans/2026-06-23-codex-models-format.md
git commit -m "docs: add codex models format design spec & implementation plan"
```
