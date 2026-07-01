# codex install 多模型安装与搜索设计

**日期**: 2026-06-25
**状态**: Draft
**范围**: v0 — 把 `codex install` 的"单选默认模型"改为"多选筛选 catalog 子集（默认全选）+ 单独选默认模型"，并为两步选择加入搜索过滤

## 1. 目标

`codex install` 当前把 `/codex/v1/models` 返回的**全部**模型写入 catalog 文件，再用 `clack.select` 单选一个默认模型写进 `config.toml` 的 `model =`。本次改为：

- **多选**决定哪些模型写入 catalog 文件（默认全选，可任意增减，未选的不进 codex picker）
- 多选完成后**单独单选**一个默认模型写 `model =`（从已选子集中选）
- 两步选择均支持**搜索过滤**（模型多时可键入过滤）

**不在范围内**:

- 不改 `config.toml` 的 4 处编辑逻辑（`applyCodexConfigEdits` 仍写 `model_catalog_json` / `model_provider` / `model` / `[model_providers.llm-proxy]`，`modelSlug` 仍是单个默认模型）
- 不改 `buildCodexBaseUrl` / `fetchCodexModelsResponse` / `codex-home` / `toml-editor`
- 不加非交互 flags（`--model` / `--all` 等），保持纯交互
- 不改 catalog 文件格式（仍是 `{models: [...]}`，原样存，只是 `models` 改为子集）

## 2. 背景

`codex install` 现状流程：load settings → 检查 `config.toml` 存在 → fetch catalog → 非空检查 → **写 catalog 文件（全部模型）** → `clack.select` 单选默认模型 → 编辑 `config.toml`。选择步用 `clack.select`（箭头单选，无搜索）。catalog 文件已含全部模型，单选仅决定 `model =` 默认值。

本次只改交互层：把"选默认模型"一步拆成"多选子集 + 单选默认"两步，并升级为 clack 的 autocomplete 变体以支持搜索。

## 3. 架构

### 数据流

```
runCodexInstall:
  load settings → 检查 config.toml → fetch catalog → 非空检查
  → selectModels(全量)            ← autocompleteMultiselect，默认全选 + 搜索
  → subset 防御校验(非空 + slugs ⊆ catalog)
  → selectDefaultModel(subset)    ← autocomplete，搜索 + 单选；subset 1 个时跳过
  → default 校验(∈ subset)
  → 写 catalog 文件(仅 subset)
  → 读 config.toml → applyCodexConfigEdits(modelSlug=default) → 写回
  → outro
```

prompts 全部前置于文件写入：任一步取消 → 不写任何文件（比现状"cancel 仍残留 catalog 文件"更干净，有意改进）。

### 选择步的跳过规则

- **fetched catalog 只有 1 个模型** → 跳过 `selectModels`（`subset = all`）→ 跳过 `selectDefaultModel`（`default = 唯一项`）→ 直接写文件
- **`selectModels` 返回子集长度为 1** → 跳过 `selectDefaultModel`，`default = 唯一项`
- 其余情况两步都走

## 4. 组件

### 注入接缝 `CodexInstallPrompts`

现有 `selectModel(models): Promise<string | null>` 重命名并扩展为两个方法：

```typescript
export interface CodexInstallPrompts {
  /** 多选模型子集，返回选中的 slug 数组；null 表示取消。默认实现用 clack.autocompleteMultiselect。 */
  selectModels(models: CodexModelInfo[]): Promise<string[] | null>
  /** 从子集中单选默认模型，返回 slug；null 表示取消。默认实现用 clack.autocomplete。 */
  selectDefaultModel(models: CodexModelInfo[]): Promise<string | null>
}
```

### `defaultPrompts()` 实现

```typescript
function matchModel(search: string, m: { slug: string; display_name: string }): boolean {
  const q = search.toLowerCase()
  return m.slug.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q)
}

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
          matchModel(search, {
            slug: String(option.value),
            display_name: option.label ?? String(option.value),
          }),
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
          matchModel(search, {
            slug: String(option.value),
            display_name: option.label ?? String(option.value),
          }),
      })
      if (clack.isCancel(selected)) return null
      return selected as string
    },
  }
}
```

- `autocompleteMultiselect`：`initialValues = 全部 slug`（默认全选）、`required: true`（至少 1 个）、自定义 `filter` 匹配 `display_name` + `slug`（大小写不敏感）
- `autocomplete`：`initialValue = subset[0]`、同款 `filter`
- 搜索时 autocomplete 只隐藏不匹配项，已选状态保留（默认全选场景下，过滤后仍可对可见项增减）

### `runCodexInstall` 选择段（步骤 5–8）

```typescript
// 5. 多选子集（fetched 1 个则跳过）。
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
// 注入 seam 守卫：子集非空 + slugs ⊆ catalog。
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

// 6. 单选默认（subset 1 个则跳过）。
let defaultSlug: string
if (subset.length === 1) {
  defaultSlug = subset[0]!.slug
} else {
  let picked: string | null
  try {
    picked = await prompts.selectDefaultModel(subset)
  } catch (err) {
    clack.log.error(
      `Default model selection failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    clack.outro('Aborted')
    return
  }
  if (picked === null) {
    clack.cancel('Operation cancelled')
    return
  }
  if (!subset.some((m) => m.slug === picked)) {
    clack.log.error(`Selected default model "${picked}" is not in the selection`)
    clack.outro('Aborted')
    return
  }
  defaultSlug = picked
}

// 7. 写 catalog 文件（仅 subset）。
await fs.writeFile(catalogPath, JSON.stringify({ models: subset }, null, 2))

// 8. 编辑 config.toml（modelSlug=defaultSlug）。
const { content: newConfig, overwritten } = applyCodexConfigEdits(rawConfig, {
  catalogFilename: DEFAULT_CATALOG_FILENAME,
  providerId: 'llm-proxy',
  providerName: 'LLM Proxy',
  baseUrl,
  wireApi: 'responses',
  modelSlug: defaultSlug,
})
```

> 现有错误处理风格保留：每个 prompt 调用 `try/catch` → `clack.log.error` + `clack.outro('Aborted')` + `return`；取消 → `clack.cancel` + `return`。

## 5. 错误处理与取消

- `selectModels` / `selectDefaultModel` 抛错 → `clack.log.error` + `clack.outro('Aborted')` + `return`
- 任一步返回 `null`（取消）→ `clack.cancel('Operation cancelled')` + `return`，**不写任何文件**
- `autocompleteMultiselect` 的 `required: true` 阻止提交空选；但注入实现可能不强制 → `runCodexInstall` 防御 `subsetSlugs.length === 0`
- 注入 seam 守卫：返回的 slug 必须存在于 catalog / subset（防注入或自定义 prompts 返回非法 slug），仿现有 `selectModel` 后的 slug 校验
- catalog 写入失败 / `config.toml` 读写失败：沿用现有 `clack.log.error` + `clack.outro('Aborted')` + `return`

## 6. 测试策略

修改 `test/cli/codex-install.test.ts`。现有用例注入的 `selectModel` 改为 `selectModels` + `selectDefaultModel`。全程注入 fetch/fs/prompts + temp dir，不依赖真实 codex CLI，无网络。

新增/调整用例：

- **默认全选写全部 catalog**：`selectModels` 返回全部 slug → catalog 文件含全部模型；subset 为多个故 `selectDefaultModel` 被调用，`model =` 其返回值
- **筛选子集只写 subset**：`selectModels` 返回部分 slug → catalog 文件只含 subset、未选的不在
- **subset 1 个跳过默认**：`selectModels` 返回 1 个 slug → `selectDefaultModel` 未被调用、`model =` 该 slug
- **fetched 1 个跳过两步**：catalog 仅 1 个模型 → `selectModels` / `selectDefaultModel` 均未被调用、catalog 写该 1 个、`model =` 该 slug
- **cancel at `selectModels`**：返回 `null` → catalog 与 config.toml 均未写
- **cancel at `selectDefaultModel`**：返回 `null` → catalog 与 config.toml 均未写（因写入在两步之后）
- **subset 空守卫**：`selectModels` 返回 `[]` → abort，不写文件
- **非法 slug 守卫**：`selectModels` 返回不在 catalog 的 slug → abort
- **默认非法守卫**：`selectDefaultModel` 返回不在 subset 的 slug → abort
- `defaultPrompts` 的 `matchModel` 纯函数：单独测 `slug` / `display_name` 大小写不敏感匹配（可导出 `matchModel` 供测试）

## 7. 与现有代码的复用

- `buildCodexBaseUrl` / `fetchCodexModelsResponse` / `CodexEndpointError` / `mapEndpointError`（`src/cli/codex-install.ts`）：直接复用，不改
- `applyCodexConfigEdits` / `CodexConfigEdits` / `TomlOverwriteReport`（`src/cli/codex-toml.ts`）：直接复用，`modelSlug` 仍是单个默认
- `resolveCodexHome` / `resolveCodexConfigPath` / `resolveCodexCatalogPath` / `DEFAULT_CATALOG_FILENAME`（`src/cli/codex-home.ts`）：直接复用
- `codexModelInfoSchema` / `CodexModelInfo`（`src/codex-types.ts`）：直接复用
- `@clack/prompts` 的 `autocomplete` / `autocompleteMultiselect` / `isCancel` / `cancel`：1.5.1 已提供，无需新依赖

## 8. 约束与已知陷阱

- **prompts 前置于写入**：取消不留副作用，但意味着 catalog 文件写入消息（`Wrote catalog → …`）移到选择步之后；现有测试断言写入顺序需同步调整
- **`autocompleteMultiselect` 搜索不取消已选**：默认全选 + 搜索时，不匹配项仅隐藏、仍保留选中状态；用户搜索后对可见项取消勾选是有效操作，提交后 subset = 仍勾选的全部（含未显示的）。符合"默认全选可减选"预期
- **`required: true` 仅约束默认实现**：注入的 `selectModels` 可能返回空，`runCodexInstall` 必须防御 `length === 0`
- **`model =` 是单值**：`applyCodexConfigEdits` 的 `modelSlug` 只接受一个 slug；多选结果只影响 catalog 文件内容，不影响 `model =` 结构
- **`autocomplete` 单选无 `required`**：单选必返回一个值或取消，无需空选守卫
- **TS 严格**：`autocompleteMultiselect` 返回 `Value[] | symbol`，`autocomplete` 返回 `Value | symbol`；`isCancel` 后 `as string[]` / `as string` 收窄（仿现有 `select` 用法）。`option.value` 在 `filter` 内为 `Value`，用 `String()` 转换以匹配 `matchModel` 入参
- **导入**：`autocomplete` / `autocompleteMultiselect` 从 `@clack/prompts` 具名导入（`import * as clack` 已覆盖，沿用 `clack.autocomplete` / `clack.autocompleteMultiselect`）
- **`matchModel` 导出**：为可测，从 `codex-install.ts` 导出该纯函数
