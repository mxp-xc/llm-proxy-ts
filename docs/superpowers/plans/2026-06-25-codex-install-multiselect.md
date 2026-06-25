# codex install 多模型安装与搜索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `codex install` 的"单选默认模型"改为"多选筛选 catalog 子集（默认全选）+ 单独单选默认模型"，两步选择均支持搜索过滤。

**Architecture:** 改 `src/cli/codex-install.ts` 的注入接缝 `CodexInstallPrompts`（`selectModel` → `selectModels` + `selectDefaultModel`），`defaultPrompts` 用 `clack.autocompleteMultiselect` / `clack.autocomplete` 实现搜索，`runCodexInstall` 把选择步前置于文件写入（多选子集 → 跳过规则 → 单选默认 → 写子集 catalog → 编辑 config.toml）。catalog 文件改写为只含选中子集 `{models: subset}`，`applyCodexConfigEdits` 不动。

**Tech Stack:** TypeScript (ESM/NodeNext), Commander.js v15, @clack/prompts 1.5.1（`autocomplete` / `autocompleteMultiselect`）, vitest, node:fs/promises。

## Global Constraints

- **导入**：所有本地导入必须用 `.js` 扩展名（ESM + NodeNext）。
- **TS 严格**：`noUncheckedIndexedAccess`（索引访问需 `!` 或 null 检查）、`exactOptionalPropertyTypes`（可选字段用 `field?: T`，不在可选位传 `undefined`）、`verbatimModuleSyntax`（仅类型导入用 `import type`）、`noImplicitOverride`。
- **禁止 `unknown`**：入参/返回值禁止 `unknown`（catch 体例外）；`JSON.parse` 返回 `any`，用 `as { ... }` 收窄到具名类型。
- **CLI 错误处理**：错误处理节点用 `clack.log.error(...)` + `clack.outro('Aborted')` + `return`，不静默；每个 clack prompt 后必须 `clack.isCancel` 检查 → `clack.cancel('Operation cancelled')` + `return`。
- **测试**：vitest，无网络，注入 `fetchImpl`/`fs`/`prompts` + `test/helpers/temp-file.ts` 的 `createTempDir`/`writeTempSettings` + `test/helpers/settings.ts` 的 `makeSettings`。不测 Commander 层。
- **缩进**：2 空格；catalog 文件 `JSON.stringify({ models: subset }, null, 2)`。
- **固定值**：catalog 文件名 `llm-proxy-model-catalog.json`；provider id `llm-proxy`；`name = "LLM Proxy"`；`wire_api = "responses"`；`base_url = "http://{host}:{port}/codex/v1"`（无 trailing slash；host 含 `:` 用 `[host]`）。
- **config.toml**：不存在则报错退出，绝不创建。
- **不变**：`buildCodexBaseUrl` / `fetchCodexModelsResponse` / `applyCodexConfigEdits` / `codex-home` / `toml-editor` 不改；`config.toml` 的 4 处编辑逻辑不变（`modelSlug` 仍是单个默认模型）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/cli/codex-install.ts` | Modify | `CodexInstallPrompts` 接口；`defaultPrompts`（autocomplete + 搜索）；`runCodexInstall` 选择段重排；新增导出 `matchModel` 纯函数 |
| `test/cli/codex-install.test.ts` | Modify | 改注入为 `selectModels`+`selectDefaultModel`；新增 `matchModel` 测试与多选/搜索/跳过/取消/守卫用例；删旧的"cancel 时 catalog 已写入"断言（行为已变） |

复用现有：`codex-types.ts` 的 `CodexModelInfo`；`config.ts` 的 `Settings`/`loadSettingsFromFile`；`codex-home.ts` 的 `resolveCodexHome`/`resolveCodexConfigPath`/`resolveCodexCatalogPath`/`DEFAULT_CATALOG_FILENAME`；`codex-toml.ts` 的 `applyCodexConfigEdits`；`@clack/prompts` 1.5.1 的 `autocomplete`/`autocompleteMultiselect`/`isCancel`/`cancel`。无新依赖。

---

### Task 1: `matchModel` 纯函数 + 测试

**Files:**
- Modify: `src/cli/codex-install.ts`（新增 `matchModel` 导出，插在 `defaultPrompts` 之前）
- Test: `test/cli/codex-install.test.ts`（新增 `describe('matchModel')`）

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `matchModel(search: string, model: { slug: string; display_name: string }): boolean`（供 Task 2 的 `defaultPrompts` filter 使用）

- [ ] **Step 1: 写失败测试 — 在 `test/cli/codex-install.test.ts` 顶部 import 区加 `matchModel`，并在 `makeModel` 之后插入 `describe('matchModel')`**

在 import 行（第 6 行）改为：

```typescript
import { buildCodexBaseUrl, fetchCodexModelsResponse, runCodexInstall, matchModel } from '../../src/cli/codex-install.js'
```

在 `makeModel` 函数之后（`describe('buildCodexBaseUrl')` 之前）插入：

```typescript
describe('matchModel', () => {
  it('empty search matches all', () => {
    expect(matchModel('', { slug: 'a', display_name: 'A' })).toBe(true)
  })
  it('matches slug substring case-insensitively', () => {
    expect(matchModel('GLM', { slug: 'zhipu/glm-5.2', display_name: 'GLM-5.2' })).toBe(true)
  })
  it('matches display_name substring case-insensitively', () => {
    expect(matchModel('proxy', { slug: 'x', display_name: 'LLM Proxy' })).toBe(true)
  })
  it('returns false when no match', () => {
    expect(matchModel('zzz', { slug: 'a', display_name: 'A' })).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/cli/codex-install.test.ts`
Expected: FAIL — `matchModel` 未导出 / is not a function

- [ ] **Step 3: 实现 `matchModel` — 在 `src/cli/codex-install.ts` 的 `defaultPrompts` 函数之前插入**

```typescript
/** Case-insensitive substring match against a model's slug and display_name. Empty search matches all. */
export function matchModel(search: string, model: { slug: string; display_name: string }): boolean {
  if (search === '') return true
  const q = search.toLowerCase()
  return model.slug.toLowerCase().includes(q) || model.display_name.toLowerCase().includes(q)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/cli/codex-install.test.ts`
Expected: PASS — `matchModel` 4 个用例通过（其余 `runCodexInstall` 用例仍用旧 `selectModel` 注入，暂维持现状）

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 通过（新增导出函数不影响现有类型）

- [ ] **Step 6: 提交**

```bash
git add src/cli/codex-install.ts test/cli/codex-install.test.ts
git commit -m "feat(cli): add matchModel pure filter for codex model search"
```

---

### Task 2: 多选 + 搜索选择流程（接口 + defaultPrompts + runCodexInstall + 测试）

**Files:**
- Modify: `src/cli/codex-install.ts:87-118`（`CodexInstallPrompts` 接口 + `defaultPrompts`）、`src/cli/codex-install.ts:175-235`（`runCodexInstall` 选择与写入段）
- Test: `test/cli/codex-install.test.ts`（重写 `runCodexInstall` describe 块）

**Interfaces:**
- Consumes: Task 1 的 `matchModel`
- Produces: `CodexInstallPrompts.selectModels(models): Promise<string[] | null>`、`CodexInstallPrompts.selectDefaultModel(models): Promise<string | null>`；`runCodexInstall` 新选择流程

- [ ] **Step 1: 重写 `test/cli/codex-install.test.ts` 的 `runCodexInstall` describe 块（整块替换）**

将 `describe('runCodexInstall', () => { ... })` 整块（从 `describe('runCodexInstall'` 到文件末尾的对应 `})`）替换为下面的完整内容。`buildCodexBaseUrl` / `fetchCodexModelsResponse` / `matchModel` 的 describe 块不动。

```typescript
describe('runCodexInstall', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> }
  let settings: { path: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    tmp = await createTempDir('codex-install-')
    settings = await writeTempSettings(JSON.stringify({
      service: { name: 'llm-proxy', host: '127.0.0.1', port: 8056 },
      providers: {},
      routing: { enableFlatModelLookup: true },
      codex: { templateSlug: 'gpt-5.5', context_window: 204800 },
    }))
  })
  afterEach(async () => {
    await tmp.cleanup()
    await settings.cleanup()
  })

  it('aborts when config.toml missing, no fetch, no catalog written', async () => {
    const fetchImpl = vi.fn()
    const writeFileSpy = vi.fn()
    const selectModels = vi.fn().mockResolvedValue(['a'])
    const selectDefaultModel = vi.fn().mockResolvedValue('a')
    const fs = wrapFs({ writeFile: writeFileSpy, access: async () => { throw new Error('enoent') } })
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels, selectDefaultModel },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(writeFileSpy).not.toHaveBeenCalled()
    expect(selectModels).not.toHaveBeenCalled()
  })

  it('aborts on fetch network error', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['a'], selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts on empty models', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['a'], selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('succeeds with default-all: writes full catalog + edits config.toml', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), '# codex\nmodel = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('zhipu/glm-5.2', 'GLM-5.2'), makeModel('gpt-5', 'GPT-5')] }),
    }) as unknown as typeof fetch
    let writtenConfig = ''
    let writtenCatalog = ''
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => {
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
    }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2', 'gpt-5'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    const catalog = JSON.parse(writtenCatalog) as { models: { slug: string }[] }
    expect(catalog.models.map((m) => m.slug).sort()).toEqual(['gpt-5', 'zhipu/glm-5.2'])
    expect(writtenConfig).toContain('model_catalog_json = "llm-proxy-model-catalog.json"')
    expect(writtenConfig).toContain('model_provider = "llm-proxy"')
    expect(writtenConfig).toContain('model = "zhipu/glm-5.2"')
    expect(writtenConfig).toContain('[model_providers.llm-proxy]')
    expect(writtenConfig).toContain('# codex') // comment preserved
  })

  it('filters catalog to the selected subset', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b'), makeModel('c')] }),
    }) as unknown as typeof fetch
    let writtenCatalog = ''
    let writtenConfig = ''
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => {
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
    }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['a', 'c'],
        selectDefaultModel: async () => 'a',
      },
    })
    const catalog = JSON.parse(writtenCatalog) as { models: { slug: string }[] }
    expect(catalog.models.map((m) => m.slug).sort()).toEqual(['a', 'c'])
    expect(writtenConfig).toContain('model = "a"')
  })

  it('skips default selection when subset has a single model', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const selectDefaultModel = vi.fn().mockResolvedValue('a')
    let writtenConfig = ''
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => { if (p.endsWith('config.toml')) writtenConfig = d },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
    }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['b'], selectDefaultModel },
    })
    expect(selectDefaultModel).not.toHaveBeenCalled()
    expect(writtenConfig).toContain('model = "b"')
  })

  it('skips both prompts when catalog has a single model', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('zhipu/glm-5.2', 'GLM-5.2')] }),
    }) as unknown as typeof fetch
    const selectModels = vi.fn().mockResolvedValue(['zhipu/glm-5.2'])
    const selectDefaultModel = vi.fn().mockResolvedValue('zhipu/glm-5.2')
    let writtenCatalog = ''
    let writtenConfig = ''
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => {
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
    }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels, selectDefaultModel },
    })
    expect(selectModels).not.toHaveBeenCalled()
    expect(selectDefaultModel).not.toHaveBeenCalled()
    expect(writtenCatalog).toContain('zhipu/glm-5.2')
    expect(writtenConfig).toContain('model = "zhipu/glm-5.2"')
  })

  it('cancel at selectModels: nothing written', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => null, selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('cancel at selectDefaultModel: nothing written', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['a', 'b'], selectDefaultModel: async () => null },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectModels returns an empty array (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => [], selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectModels returns a slug not in the catalog (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['nonexistent'], selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectDefaultModel returns a slug not in the subset (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['a', 'b'], selectDefaultModel: async () => 'nonexistent' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/cli/codex-install.test.ts`
Expected: FAIL — 编译错误（`selectModel` 不再存在于 `CodexInstallPrompts`）或 `runCodexInstall` 旧行为不满足新断言（cancel/守卫用例期望"不写文件"但旧实现先写 catalog）

- [ ] **Step 3: 实现 — 改 `CodexInstallPrompts` 接口**

将 `src/cli/codex-install.ts` 的接口（当前 87-89 行）：

```typescript
export interface CodexInstallPrompts {
  selectModel(models: CodexModelInfo[]): Promise<string | null>
}
```

替换为：

```typescript
export interface CodexInstallPrompts {
  /** Multi-select models to install; returns selected slugs, or null on cancel. */
  selectModels(models: CodexModelInfo[]): Promise<string[] | null>
  /** Single-select the default model from the subset; returns slug, or null on cancel. */
  selectDefaultModel(models: CodexModelInfo[]): Promise<string | null>
}
```

- [ ] **Step 4: 实现 — 改 `defaultPrompts`（用 autocomplete + matchModel）**

将 `defaultPrompts` 函数（当前 106-118 行）整体替换为：

```typescript
function defaultPrompts(): CodexInstallPrompts {
  return {
    async selectModels(models) {
      const slugs = models.map((m) => m.slug)
      const selected = await clack.autocompleteMultiselect({
        message: 'Select models to install',
        options: models.map((m) => ({ value: m.slug, label: m.display_name, hint: m.slug })),
        initialValues: slugs,
        required: true,
        placeholder: 'Type to filter models…',
        filter: (search, option) =>
          matchModel(search, { slug: option.value, display_name: option.label ?? option.value }),
      })
      if (clack.isCancel(selected)) return null
      return selected as string[]
    },
    async selectDefaultModel(models) {
      const selected = await clack.autocomplete({
        message: 'Select default model',
        options: models.map((m) => ({ value: m.slug, label: m.display_name, hint: m.slug })),
        initialValue: models[0]!.slug,
        placeholder: 'Type to filter models…',
        filter: (search, option) =>
          matchModel(search, { slug: option.value, display_name: option.label ?? option.value }),
      })
      if (clack.isCancel(selected)) return null
      return selected as string
    },
  }
}
```

- [ ] **Step 5: 实现 — 重排 `runCodexInstall` 选择与写入段**

将 `runCodexInstall` 内从 `// 5. Write catalog file.` 注释起、到函数末尾 `clack.outro('Done. Restart codex to load the new catalog and provider.')` 止的整段（当前 175-235 行）替换为：

```typescript
  // 5. Select models to install (skip the prompt when the catalog has a single model).
  let subsetSlugs: string[] | null
  if (modelsRes.models.length === 1) {
    subsetSlugs = [modelsRes.models[0]!.slug]
  } else {
    try {
      subsetSlugs = await prompts.selectModels(modelsRes.models)
    } catch (err) {
      clack.log.error(`Model selection failed: ${err instanceof Error ? err.message : String(err)}`)
      clack.outro('Aborted')
      return
    }
  }
  if (subsetSlugs === null) {
    clack.cancel('Operation cancelled')
    return
  }
  // Guard the prompt-injection seam: subset must be non-empty and every slug must be in the catalog.
  if (
    subsetSlugs.length === 0 ||
    !subsetSlugs.every((s) => modelsRes.models.some((m) => m.slug === s))
  ) {
    clack.log.error('Invalid model selection')
    clack.outro('Aborted')
    return
  }
  const slugs: string[] = subsetSlugs
  const subset = modelsRes.models.filter((m) => slugs.includes(m.slug))

  // 6. Select default model (skip the prompt when the subset has a single model).
  let defaultSlug: string
  if (subset.length === 1) {
    defaultSlug = subset[0]!.slug
  } else {
    let picked: string | null
    try {
      picked = await prompts.selectDefaultModel(subset)
    } catch (err) {
      clack.log.error(`Default model selection failed: ${err instanceof Error ? err.message : String(err)}`)
      clack.outro('Aborted')
      return
    }
    if (picked === null) {
      clack.cancel('Operation cancelled')
      return
    }
    // Guard the prompt-injection seam: the default must be one of the selected models.
    if (!subset.some((m) => m.slug === picked)) {
      clack.log.error(`Selected default model "${picked}" is not in the selection`)
      clack.outro('Aborted')
      return
    }
    defaultSlug = picked
  }

  // 7. Write catalog file (only the selected subset).
  try {
    await fs.mkdir(codexHome, { recursive: true })
    await fs.writeFile(catalogPath, JSON.stringify({ models: subset }, null, 2))
  } catch (err) {
    clack.log.error(`Failed to write catalog: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }
  clack.log.step(`Wrote catalog (${subset.length} model${subset.length === 1 ? '' : 's'}) → ${catalogPath}`)

  // 8. Edit config.toml.
  let rawConfig: string
  try {
    rawConfig = await fs.readFile(configPath)
  } catch (err) {
    clack.log.error(`Failed to read config.toml: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }
  const { content: newConfig, overwritten } = applyCodexConfigEdits(rawConfig, {
    catalogFilename: DEFAULT_CATALOG_FILENAME,
    providerId: 'llm-proxy',
    providerName: 'LLM Proxy',
    baseUrl,
    wireApi: 'responses',
    modelSlug: defaultSlug,
  })
  for (const report of overwritten) {
    clack.log.warn(`Overwrote ${report.key}: ${report.oldValue} → ${report.newValue}`)
  }
  try {
    await fs.writeFile(configPath, newConfig)
  } catch (err) {
    clack.log.error(`Failed to write config.toml: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }
  clack.log.success(`Updated ${configPath}`)
  clack.outro('Done. Restart codex to load the new catalog and provider.')
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test test/cli/codex-install.test.ts`
Expected: PASS — 全部 `matchModel` + `runCodexInstall` 新用例通过

- [ ] **Step 7: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 通过，全量测试无回归

- [ ] **Step 8: 提交**

```bash
git add src/cli/codex-install.ts test/cli/codex-install.test.ts
git commit -m "feat(cli): support multi-select and search in codex install"
```
