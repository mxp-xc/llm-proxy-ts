# Architecture Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen 7 shallow-module / locality friction points identified by `/improve-codebase-architecture` — consolidate model enumeration, relocate codex schemas, inject codex cache, inline stream-normalize, structurize error phases, extract CLI discovery + shared tool mapper — without breaking any HTTP contract.

**Architecture:** Eight sequential tasks across three chains (codex consolidation T1→T2→T3; CLI T6→T7) plus three independent (T4 stream, T5 handle-protocol, T8 providers). Each task is a fresh-implementer + reviewer gate under SDD. Refactors preserve behavior; new tests back the few logic changes.

**Tech Stack:** TypeScript (ESM + NodeNext), Hono, Vercel AI SDK (`ai`), Zod (`zod/v3`), Vitest, pnpm.

## Global Constraints

- TS ESM + NodeNext: **all local imports use `.js` extensions**
- `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` enabled
- Zod imported as `import { z } from 'zod/v3'`
- No `unknown` params/returns except: external input validation, error handling, passthrough fields (see `.claude/rules/ts-development.md`)
- Tests: Vitest, no network; HTTP contracts tested via `createApp().fetch()`; pure functions tested directly
- Error nodes must log with full object: `logger.error({ err }, msg)`, never swallow
- `config/settings.schema.json` is generated (`pnpm generate:schema`); schema-source moves must keep it byte-identical
- Each task: `pnpm typecheck` + `pnpm test` green; commit only task-relevant files (never `.superpowers/` or `.claude/`)

---

## File Structure

**Create:**
- `src/codex-types.ts` — codex Zod schemas + inferred types (leaf module, only `zod/v3`)
- `src/cli/models-discovery.ts` — `discoverProviderModels` pure function (T6)
- `test/server/stream-normalize.test.ts` — normalizeStream behavior tests (T4)
- `test/cli/models-sync.test.ts` — discovery orchestration tests (T6)

**Modify (representative; pattern repeats per task):**
- `src/config.ts` — drop codex schemas, import from `codex-types.ts` (T1)
- `src/server/codex-catalog.ts` — import source (T1), consume enumeration core (T2), cache injection (T3)
- `src/providers/model-types.ts` — add `ModelEntry` + `enumerateModelEntries` (T2)
- `src/providers/models.ts`, `src/cli/models-list.ts`, `src/routing.ts` — consume enumeration core (T2)
- `src/server/codex.ts`, `src/server/types.ts`, `src/server/app.ts` — cache injection (T3)
- `src/server/gateway.ts` — inline normalizeStream (T4); delete `src/server/stream-normalize.ts`
- `src/server/handle-protocol.ts` — ErrorPhase (T5)
- `src/cli/models-sync.ts`, `src/server/server.ts`, `src/oauth/` — discovery extraction (T6/T7)
- `src/providers/shared/protocol-utils.ts` + three `protocol.ts` — `mapToolToAISDK` (T8)

---

### Task 1: Relocate codex schemas to leaf module `src/codex-types.ts`

**Files:**
- Create: `src/codex-types.ts`
- Modify: `src/config.ts:48-139` (remove codex schema block), `src/server/codex-catalog.ts:4`, `test/server/codex-catalog.test.ts:7`
- Test: existing `test/server/codex-*.test.ts`, `test/config.test.ts` (regression guards)

**Interfaces:**
- Produces: `codexModelInfoSchema`, `codexModelOverrideSchema`, `codexSettingsSchema`, types `CodexModelInfo`/`CodexModelOverride`/`CodexSettings` — all exported from `src/codex-types.ts`
- Consumes: nothing (leaf module, only `zod/v3`)

- [ ] **Step 1: Create `src/codex-types.ts`** with `import { z } from 'zod/v3'` only. Move verbatim from `config.ts`: `codexReasoningLevelSchema`, `codexModelMessagesSchema`, `codexTruncationPolicySchema`, `codexModelInfoSchema` (30+ fields, `.passthrough()`), `codexModelOverrideSchema` (`.omit({slug}).partial().extend({templateSlug}).strip()`), `codexSettingsSchema` (`.extend({templateSlug default 'gpt-5.4', context_window default 200000}).strip()`). Export the three inferred types. Preserve chain order — do not reorder.
- [ ] **Step 2: Update `src/config.ts`** — delete the codex schema block; add `import { codexModelOverrideSchema, codexSettingsSchema } from './codex-types.js'`. Keep the three mount sites unchanged: `modelRouteConfigSchema` `codex: codexModelOverrideSchema.optional()`, `commonProviderOptionsSchema` same, `settingsSchema` `codex: codexSettingsSchema.default({})`.
- [ ] **Step 3: Update `src/server/codex-catalog.ts:4`** — split import: `codexModelInfoSchema`/`CodexModelInfo`/`CodexModelOverride` from `'../codex-types.js'`; `Settings` stays from `'../config.js'`.
- [ ] **Step 4: Update test imports** — `test/server/codex-catalog.test.ts:7` `CodexModelInfo` from `'../../src/codex-types.js'`. Grep `codexModelInfoSchema|CodexModelInfo|codexModelOverrideSchema|CodexModelOverride|codexSettingsSchema|CodexSettings` across `test/` and fix any remaining `config.js` source.
- [ ] **Step 5: Verify** — `pnpm typecheck` ✓; `pnpm test` ✓ (399+); `pnpm generate:schema && git diff --stat config/settings.schema.json` **empty**; confirm `src/codex-types.ts` has no `config.js` import (no cycle).
- [ ] **Step 6: Commit** — `git add src/codex-types.ts src/config.ts src/server/codex-catalog.ts test/server/codex-catalog.test.ts`; `git commit -m "refactor: extract codex schemas to leaf module codex-types.ts"`

---

### Task 2: Extract shared model enumeration core

**Files:**
- Modify: `src/providers/model-types.ts` (add `ModelEntry` + `enumerateModelEntries`)
- Modify: `src/providers/models.ts:13` (`listModels`), `src/cli/models-list.ts:21` (`collectRows`), `src/server/codex-catalog.ts:61` (`enumerateModelEntries`), `src/routing.ts:45` (evaluate)
- Test: `test/providers/models.test.ts`, `test/cli/models-list.test.ts`, `test/server/codex-catalog.test.ts`, `test/routing.test.ts`; new direct unit test for `enumerateModelEntries`

**Interfaces:**
- Produces: `ModelEntry` interface and `enumerateModelEntries(settings: Settings): ModelEntry[]` in `src/providers/model-types.ts`
- Consumes: `isFlatLookupEnabled` from `src/config-helpers.js`; `Settings` from `src/config.js`; `ModelLimit` (already in `model-types.ts`)

`ModelEntry` shape (per modelKey, carries all its ids):
```ts
export interface ModelEntry {
  providerName: string
  modelKey: string
  upstreamModel: string
  aliases: string[]
  limit: ModelLimit | undefined
  flat: boolean
  ids: string[]  // [`${providerName}/${modelKey}`, ...(flat ? [modelKey, ...aliases] : [])]
}
```

- [ ] **Step 1: Write failing test** `test/providers/enumerate-models.test.ts` — assert: flat disabled → entries only `provider/modelKey`; flat enabled → adds `modelKey` + each alias; mixed providers; `upstreamModel`/`aliases`/`flat` populated correctly.
- [ ] **Step 2: Run, verify FAIL** — `pnpm test test/providers/enumerate-models.test.ts` → fails (not defined).
- [ ] **Step 3: Implement** in `src/providers/model-types.ts` — add `ModelEntry` + `enumerateModelEntries` (logic = current `codex-catalog.ts:61-76` traversal, but build full `ModelEntry` with `upstreamModel`/`aliases`/`flat`). Import `Settings` from `'../config.js'`, `isFlatLookupEnabled` from `'../config-helpers.js'`.
- [ ] **Step 4: Run, verify PASS** — `pnpm test test/providers/enumerate-models.test.ts` ✓.
- [ ] **Step 5: Refactor consumers** — `listModels` (`models.ts`) → `enumerateModelEntries(settings).flatMap(e => e.ids.map(id => makeModel(id, e.providerName, e.limit)))` wrapped in `{ object: 'list', data }`. `collectRows` (`models-list.ts`) → map each `ModelEntry` to `ModelRow` (`ids` already on entry). `buildCodexModelsResponse` (`codex-catalog.ts`) → delete local `enumerateModelEntries`, import from `model-types.js`; loop `for (const entry of entries) { ...resolve template/config once... for (const id of entry.ids) { push info with slug=id } }` (codex-catalog.test.ts is the guard). `routing.ts` `RoutingTable.fromSettings`: reuse `enumerateModelEntries` reading `entry.modelKey`/`entry.aliases`/`entry.flat` + `settings.providers[entry.providerName]` for `buildRoute`, keep ambiguous-route detection; **`routing.test.ts` ambiguous-case must stay green** (if reuse adds friction, keep independent traversal + comment pointing at the shared helper).
- [ ] **Step 6: Verify** — `pnpm typecheck` ✓; `pnpm test` ✓ (all enumeration consumers green).
- [ ] **Step 7: Commit** — `git commit -m "refactor: extract shared model enumeration core into model-types.ts"`

---

### Task 3: Inject codex catalog cache

**Files:**
- Modify: `src/server/codex-catalog.ts` (replace module-level cache + `__reset` with `CodexCatalogCache` class), `src/server/codex.ts`, `src/server/types.ts`, `src/server/app.ts:46,160`
- Modify: `test/server/codex-catalog.test.ts`, `test/server/codex-endpoint.test.ts:8,41,47,62,72`

**Interfaces:**
- Produces: `CodexCatalogCache` class in `src/server/codex-catalog.ts` with `get(fetcher: CodexCatalogFetcher): Promise<Map<string, CodexModelInfo>>`
- Consumes: `enumerateModelEntries` (from T2) inside `buildCodexModelsResponse`; `CodexCatalogFetcher` type

- [ ] **Step 1: Add `CodexCatalogCache` class** in `codex-catalog.ts` — encapsulate the lazy + concurrent-dedup body of current `fetchCodexBundledCatalog` (fields `cached`/`inflight`, method `get(fetcher)`). Delete module-level `cachedCatalog`/`inflight`/`__resetCodexCatalogCacheForTest`. Delete free function `fetchCodexBundledCatalog` (single entry via instance).
- [ ] **Step 2: Update `codex.ts`** — `CodexAppDeps` takes `catalogCache: CodexCatalogCache` (and optional `fetcher`); `/v1/models` calls `cache.get(fetcher)`.
- [ ] **Step 3: Update `types.ts`** — `AppDependencies`: drop `codexCatalogFetcher?: () => Promise<string>`, add `codexCatalogCache?: CodexCatalogCache`.
- [ ] **Step 4: Update `app.ts`** — destructure `codexCatalogCache`; `const catalogCache = deps.codexCatalogCache ?? new CodexCatalogCache()` once at `createApp` scope (process-shared, **not per-request**); pass to `createCodexApp`.
- [ ] **Step 5: Update tests** — `codex-catalog.test.ts`: drop `__reset` import/beforeEach, use `new CodexCatalogCache()` per case; lazy/dedup tests assert `calls===1` on fresh instance. `codex-endpoint.test.ts`: drop `__reset`; inject `codexCatalogCache: new CodexCatalogCache()` (+ fetcher) instead of `codexCatalogFetcher`.
- [ ] **Step 6: Verify** — `pnpm typecheck` ✓; `pnpm test` ✓ (codex lazy/dedup + 200/503 endpoint).
- [ ] **Step 7: Commit** — `git commit -m "refactor: inject CodexCatalogCache, remove module-level state and test backdoor"`

---

### Task 4: Inline normalizeStream into gateway.ts (TDD)

**Files:**
- Modify: `src/server/gateway.ts` (inline into `stream()`)
- Delete: `src/server/stream-normalize.ts`
- Create: `test/server/stream-normalize.test.ts`

**Interfaces:**
- Produces: none new (behavior moves into `defaultGateway.stream()`)
- Consumes: `ProxyStreamPart` type; the AI SDK quirk that `response` lives on `finish-step` not `finish`

- [ ] **Step 1: Write failing test** `test/server/stream-normalize.test.ts` — export a thin helper from `gateway.ts` (or test the inlined generator) covering: (a) `finish-step` with `response{id,timestamp}` then `finish` → `finish` carries `response`; (b) plain `finish` with no prior `finish-step` → unchanged; (c) multiple `finish-step` then `finish` → last response wins. Construct `ProxyStreamPart[]` sequences.
- [ ] **Step 2: Run, verify FAIL** — test fails (helper not exported / behavior not yet in place).
- [ ] **Step 3: Inline** into `gateway.ts` `stream()` — replace `return normalizeStream(result.fullStream as AsyncIterable<ProxyStreamPart>)` with the inline async generator (capture `lastStepResponse` from `finish-step.response`, inject on `finish`). Keep AI SDK quirk comment. Export the generator as a named function so the test can target it.
- [ ] **Step 4: Delete** `src/server/stream-normalize.ts`; remove its import from `gateway.ts`.
- [ ] **Step 5: Run, verify PASS** — `pnpm test test/server/stream-normalize.test.ts` ✓; `pnpm test` ✓ (full suite — `app.test.ts` stream paths).
- [ ] **Step 6: Commit** — `git commit -m "refactor: inline normalizeStream into gateway, add behavior tests"`

---

### Task 5: handle-protocol ErrorPhase + streamOnly timeout test

**Files:**
- Modify: `src/server/handle-protocol.ts` (`handleUpstreamError` signature + 3 call sites)
- Modify: `test/server/app.test.ts` (add streamOnly timeout test; fix any log-message assertions)

**Interfaces:**
- Produces: `type ErrorPhase = 'stream' | 'stream-only' | 'generate'` in `handle-protocol.ts`
- Consumes: unchanged `formatErrors` error formatters; HTTP response contract unchanged

- [ ] **Step 1: Grep** test assertions for `'stream request failed'|'generation request failed'` — note any to update.
- [ ] **Step 2: Write failing test** in `app.test.ts` — streamOnly provider, mock `gateway.stream` returns a stream whose first chunk never arrives within `requestTimeoutMs` → expect 504. (And a test asserting the logger receives `phase: 'stream-only'` if feasible via logger spy.)
- [ ] **Step 3: Run, verify FAIL** — timeout test fails (no 504 path coverage) / phase field absent.
- [ ] **Step 4: Implement** — change `handleUpstreamError(..., logMessage: string)` → `handleUpstreamError(..., phase: ErrorPhase)`; log `c.get('logger').error({ err: error, phase }, 'upstream request failed')`. Update 3 call sites: L143 `'stream'`, L174 `'stream-only'`, L200 `'generate'`. HTTP status mapping (oauth 503 / timeout 504 / upstream 502) unchanged. Keep OAuthError dual-handling (L104-110 + L212) as safe redundancy.
- [ ] **Step 5: (Optional)** extract `buildAcquireOpts(...)` if the reviewer agrees the 8-line opts duplication is worth it; not mandatory.
- [ ] **Step 6: Run, verify PASS** — `pnpm test` ✓; fix any grep'd log-message assertions to assert `phase`.
- [ ] **Step 7: Commit** — `git commit -m "refactor: structurize handleUpstreamError phase, add streamOnly timeout test"`

---

### Task 6: Extract models-sync discovery pure function

**Files:**
- Create: `src/cli/models-discovery.ts` (`discoverProviderModels`)
- Modify: `src/cli/models-sync.ts:118-227` (replace with calls)
- Create: `test/cli/models-sync.test.ts`

**Interfaces:**
- Produces: `discoverProviderModels` in `src/cli/models-discovery.ts`
- Consumes: `fetchUpstreamModels` + `openAIToDiscoveredModels` (from `discover-models.ts`), `TokenManager`, `PluginRegistry`, `isRecord` guard

```ts
type DiscoverResult =
  | { ok: { providerName: string; models: DiscoveredModel[] } }
  | { skipped: { providerName: string; reason: string } }

async function discoverProviderModels(input: {
  providerName: string
  provider: ProviderConfig
  settings: Settings
  rawParsed: Record<string, unknown>   // isRecord-guarded, for apiKey env resolution
  pluginRegistry?: PluginRegistry
  tokenManager?: TokenManager
  authFilePath: string
  fetchUpstream?: typeof fetchUpstreamModels   // injectable for tests
}): Promise<DiscoverResult>
```

- [ ] **Step 1: Write failing test** `test/cli/models-sync.test.ts` — cases: plugin `discoverModels` wins; `anthropic`/`openai` type skipped; OAuth `needs_login` → skipped; HTTP fallback success (inject `fetchUpstream` mock).
- [ ] **Step 2: Run, verify FAIL** — module not defined.
- [ ] **Step 3: Implement** `discoverProviderModels` in `models-discovery.ts` — encapsulate current `models-sync.ts:130-226` logic (plugin first → type skip → OAuth token resolve → HTTP fallback). Use `isRecord` to converge `rawParsed`. Return the discriminated union.
- [ ] **Step 4: Refactor `runModelsSync`** — replace L118-227 with a loop calling `discoverProviderModels`; `clack.spinner` wraps the call; `{skipped}` drives spinner text; aggregate `{ok}` results. `runModelsSync` becomes thin interaction orchestration.
- [ ] **Step 5: Run, verify PASS** — `pnpm test test/cli/models-sync.test.ts` ✓; `pnpm test` ✓ (discover-models.test.ts still green).
- [ ] **Step 6: Commit** — `git commit -m "refactor: extract models-sync discovery into testable pure function"`

---

### Task 7: Shared `createTokenManagerIfNeeded` (narrowed)

**Files:**
- Modify: `src/oauth/index.ts` (or new `src/oauth/token-bootstrap.ts`)
- Modify: `src/cli/models-sync.ts:121-126`, `src/server/server.ts:44-55`

**Interfaces:**
- Produces: `createTokenManagerIfNeeded(authFilePath: string, hasOAuth: boolean): Promise<TokenManager | undefined>` in `src/oauth/`
- Consumes: `TokenManager.fromFile` + `.load()`

- [ ] **Step 1: Write failing test** — `hasOAuth=false` → returns `undefined`; `hasOAuth=true` → calls `fromFile`+`load`, returns instance.
- [ ] **Step 2: Implement** `createTokenManagerIfNeeded` — the 3-line idiom: `hasOAuth ? (TokenManager.fromFile(authFilePath), await load(), tm) : undefined`. Do NOT extract `validateOAuthStatus` (server-only) or `getStatus`+`ensureValidToken` (cli-only) — their orchestration differs.
- [ ] **Step 3: Replace** the inline idiom in `models-sync.ts:121-126` and `server.ts:44-55`.
- [ ] **Step 4: Verify** — `pnpm typecheck` ✓; `pnpm test` ✓ (token-manager / oauth-startup tests green).
- [ ] **Step 5: Commit** — `git commit -m "refactor: share createTokenManagerIfNeeded between cli and server"`

> If reviewer judges the 3-line extraction low-value, downgrade to a comment marking the duplication and skip extraction.

---

### Task 8: Extract `mapToolToAISDK` shared helper

**Files:**
- Modify: `src/providers/shared/protocol-utils.ts` (add `mapToolToAISDK`)
- Modify: `src/providers/anthropic/protocol.ts:287`, `src/providers/openai-compatible/protocol.ts:256`, `src/providers/openai-responses/protocol.ts:233`

**Interfaces:**
- Produces: `mapToolToAISDK(parameters: Record<string, unknown>, description?: string): ToolSet[string]` in `protocol-utils.ts`
- Consumes: `jsonSchema` + `ToolSet` from `'ai'`

- [ ] **Step 1: Implement** in `protocol-utils.ts`:
```ts
import { jsonSchema, type ToolSet } from 'ai'
export function mapToolToAISDK(
  parameters: Record<string, unknown>,
  description?: string,
): ToolSet[string] {
  const def: ToolSet[string] = { inputSchema: jsonSchema(parameters) }
  if (description !== undefined) def.description = description
  return def
}
```
- [ ] **Step 2: Delegate** in three `protocol.ts`: `mapAnthropicTool` → `mapToolToAISDK(tool.input_schema, tool.description)`; `mapFunctionTool` → `mapToolToAISDK(tool.function.parameters, tool.function.description)`; `mapResponsesFunctionTool` → `mapToolToAISDK(tool.parameters ?? { type: 'object', properties: {} }, tool.description)`. Keep the three function names/signatures (existing tests untouched).
- [ ] **Step 3: Verify** — `pnpm typecheck` ✓; `pnpm test` ✓ (three `protocol.test.ts` mapTool cases green).
- [ ] **Step 4: Commit** — `git commit -m "refactor: extract mapToolToAISDK shared helper"`

---

## Deferred (out of scope this round)

- `mapToolChoice` centralization — anthropic's unique `any→required` branch makes a shared helper messier.
- `providerOptions` key constants — only 3 string literals, no duplicated logic.
- `registry.createProviderModelFactory` registry pattern — 3-type if/else is clear; registry infra is over-engineering.
- `stream-inspect` DRY + `stream-utils` split — negligible payoff.

## Verification (end-to-end)

- `pnpm typecheck` green
- `pnpm test` green (incl. new tests from T2/T4/T5/T6/T7)
- `pnpm generate:schema` → `config/settings.schema.json` byte-identical (T1 gate)
- Optional smoke: `pnpm dev serve`, `curl /v1/models`, `curl /codex/v1/models`, `curl /v1/chat/completions` (stream + non-stream) — behavior unchanged
- Final: `review-package <merge-base> HEAD` → final code-reviewer → `superpowers:finishing-a-development-branch`
