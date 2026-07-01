# Codex /codex models 审查修复 Implementation Plan

> **状态:已实施** — squash 合并到 main(commit `486761a`)。本计划已更新为匹配 `72d19dd` 后的新结构(codex schema→`codex-types.ts`、`enumerateModelEntries`→`model-types.ts`、codex 缓存→`CodexCatalogCache` 注入式类、`ModelEntry.ids[]`)。

**Goal:** 修复 `/codex` models 端点代码审查发现的 8 项问题,使端点健壮(hang 可自愈、无矛盾字段、校验完整、无测试污染、无硬编码脆弱、无错误信息泄露、无 catch 二次崩溃)。

**Architecture:** 在 `72d19dd` refactor 后的新结构上逐项局部修复。`#6`(`enumerateModelEntries` 提取)已由 `72d19dd` 实现,跳过;其余 7 项重新 TDD 应用。

**Tech Stack:** TypeScript(严格模式)、Hono、Zod(`zod/v3`)、Vitest、pnpm、Node.js `child_process`。

## Context

commit `223abdf` 引入 `/codex` models 端点(4 层 catalog 覆盖)。代码审查发现 9 项问题,经核对 spec 与用户决策:8 项修复(#1/#3/#4/#5/#6/#7/#8/#9),#2 符合 spec §6 原子失败设计不修。

初次修复在 worktree 基于 `f361722` 完成,但工作期间 main 前进到 `72d19dd`(架构 refactor,行为不变):codex schema 迁到 `src/codex-types.ts`、`enumerateModelEntries` 提到 `src/providers/model-types.ts`(已实现 #6)、codex 缓存改为 `CodexCatalogCache` 注入式类、codex app 依赖 `catalogCache` 而非 `codexCatalogFetcher`、`ModelEntry` 改为 `ids: string[]`。旧 worktree squash 会冲突 4 文件且 #6 重复,故新建 worktree 基于 main 重新应用。

## Global Constraints

- 所有本地导入必须用 `.js` 扩展名(NodeNext + `verbatimModuleSyntax`)。
- `tsconfig.base.json`:`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`(勿写 `prop: undefined` 字面量赋给 optional 属性)、`verbatimModuleSyntax`、`noImplicitOverride`。
- JS/TS 用 `pnpm`;测试用 Vitest(无网络,全程 mock)。
- 日志:错误节点带完整对象与堆栈(`logger.error({ err }, msg)`),不得只 log `err.message`。
- 现有 `/v1/*` 端点行为不改动;`/codex` 仅 `/v1/responses` + `/v1/models` 两端点。

## 新结构关键文件

| 文件                           | 责任                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/codex-types.ts`           | codex schema(`codexModelInfoSchema`/`codexModelOverrideSchema`/`codexSettingsSchema`),叶子模块,仅依赖 zod/v3                                                     |
| `src/providers/model-types.ts` | `ModelEntry`(`ids: string[]`)+ `enumerateModelEntries`(72d19dd 已提取,#6)                                                                                        |
| `src/server/codex-catalog.ts`  | `CodexCatalogCache` 类(注入式,构造绑定 fetcher)+ `applyOverride` + `resolveTemplateSlug` + `resolveContextWindow` + `buildCodexModelsResponse`(遍历 `entry.ids`) |
| `src/server/codex.ts`          | `/codex` 子 app:端点 handler + 错误处理(依赖 `catalogCache: CodexCatalogCache`)                                                                                  |
| `test/helpers/settings.ts`     | `makeSettings` 测试 helper                                                                                                                                       |

## 修复项

### N1 — makeSettings codex 浅拷贝隔离(#5)

`test/helpers/settings.ts` — `makeSettings` 返回对象加 `codex: { ...baseSettings.codex }`(放 `...overrides` 前)。隔离 `codex-catalog.test.ts` 的 `settings.codex.default_reasoning_level = 'medium'` mutate 不写回 `baseSettings.codex`。

- 测试:`codex-catalog.test.ts` 加 `does not share codex reference across makeSettings calls`。

### N2 — applyOverride 过滤 max_context_window(#3)

`src/server/codex-catalog.ts` — `applyOverride` 的 filter 增加 `k !== 'max_context_window'`。`context_window` 与 `max_context_window` 始终相等(均 = `limit.context ?? 4 层 contextWindow`),消除同时配 `codex.{context_window:X, max_context_window:Y}` 且 Y<X 时 `max < context` 的矛盾。

- 测试:`codex-catalog.test.ts` 加 `max_context_window stays equal to context_window (max override ignored)`。

### N3 — context_window positive 校验(#4)

`src/codex-types.ts` — `codexModelOverrideSchema.extend` 增加 `context_window: z.number().int().positive().nullable().optional()`(覆盖从 `:62` 继承的宽松 `z.number().nullable().optional()`)。`null` 仍允许(`resolveContextWindow` 的 `??` 跳过=未设),禁 `0`/负数。`codexSettingsSchema` 的 `.extend({ context_window: positive.default(200000) })` 仍覆盖为 default。

- 测试:`codex-config.test.ts` 加 `rejects context_window <= 0` + `accepts null context_window at override layer`。

### N4 — defaultFetcher timeout+maxBuffer(#1,hang 可自愈)

`src/server/codex-catalog.ts` — `defaultFetcher` 的 `execFileAsync` 加 `{ timeout: 10_000, maxBuffer: 10 * 1024 * 1024 }`。超时后 reject(SIGTERM)→ `CodexCatalogCache.get()` 的 `finally` 清空 `inflight` → 后续请求可重试,修复 codex 子进程 hang 导致端点永久阻塞且无法自愈。

- 测试:`codex-catalog.test.ts` 加 `recovers after fetcher rejection: inflight cleared, retry succeeds`(用 `new CodexCatalogCache(fetcher)`)。

### N5 — 动态默认 templateSlug(#7)

- `src/codex-types.ts`:`codexSettingsSchema.templateSlug` 从 `default('gpt-5.4')` 改 `optional()`。
- `src/server/codex-catalog.ts`:`resolveTemplateSlug` 返回 `string | undefined`;新增 `const FALLBACK_DEFAULT_SLUG = 'gpt-5.4'` + `pickDefaultTemplateSlug(catalog)`(`catalog.values()` 首个 `supported_in_api=true` 的 slug,无则兜底);`buildCodexModelsResponse` 在 `for entry` 循环外算 `defaultSlug`(在 `for id of entry.ids` 之外,只算一次),entry 用 `resolveTemplateSlug(settings, entry) ?? defaultSlug`。用户显式配了 templateSlug 仍用它(缺失 throw);仅全层未配时动态选。
- `test/helpers/settings.ts:9`:`baseSettings.codex` 移除 `templateSlug` → `codex: { context_window: 200000 }`。
- 测试:`codex-catalog.test.ts` 断言 `base_instructions` `'codex-base'`→`'codex-5.5'`(CATALOG 中 gpt-5.4 `supported_in_api=false`、gpt-5.5 `=true`,动态默认选 gpt-5.5);用例名改 `dynamic default templateSlug picks first supported_in_api catalog entry`。`codex-config.test.ts` `templateSlug` 断言 `toBe('gpt-5.4')`→`toBeUndefined()`。

### N6 — 503 简短 reason + logger 可选链(#8+#9)

`src/server/codex.ts` — `import { ZodError } from 'zod/v3'`;catch 中 `reason = err instanceof ZodError ? 'codex catalog schema validation failed' : err instanceof Error ? err.message : String(err)`;`c.get('logger')?.error(...)`。非 ZodError 保留 `err.message`(spec §6 要求含 reason),避免回显完整 ZodError JSON。

- 测试:`codex-endpoint.test.ts` 加 `returns 503 with short reason (no ZodError JSON) on catalog schema failure`(用 `new CodexCatalogCache(async () => JSON.stringify({ models: [{}] }))` 触发 ZodError)。

### N7 — spec 同步 + schema 重生成

- `docs/superpowers/specs/2026-06-23-codex-models-format-design.md`:§3 line 46 + §5 line 126 + §9 line 220(#7 动态默认);§4 字段表 + §5 line 128 + §5 示例 + §9 line 223(#3 max 对齐);§6 line 178(#8 reason 粒度)。
- `pnpm generate:schema` 重生成 `config/settings.schema.json`(templateSlug default 移除 + context_window override 约束)。

## 不修项

- **#2**(单 provider `templateSlug` 错误 → 全站 503):spec §6 line 179 明确要求原子失败(catalog 对 codex 必须原子,避免缓存部分 catalog)。符合设计。
- **#6**(`enumerateModelEntries` 提取):`72d19dd` refactor 已实现(提取到 `src/providers/model-types.ts`,被 `listModels`/`routing`/`buildCodexModelsResponse` 共用)。跳过。

## 验证(已通过)

1. `pnpm typecheck` — 无错误。
2. `pnpm test` — 478 passed(41 files),0 失败(基线 72d19dd+358b919 的 472 + 新增 6)。
3. `pnpm generate:schema` — `config/settings.schema.json` 重生成,git diff 一致。
4. spec 同步 8 处(#3/#7/#8)。

## 实施记录

- 7 个 commit 在 `worktree-codex-review-fixes-v2` 分支(N1-N7),TDD 逐项。
- squash 合并到 main:`486761a fix(codex): harden /codex models endpoint (review fixes)`(线性,无冲突)。
- main 链:`486761a` → `358b919`(codex install CLI)→ `72d19dd`(架构 refactor)。
