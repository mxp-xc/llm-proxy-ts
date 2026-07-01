# Lazy Loading & Performance Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate ~0.5s of unnecessary module loading from CLI one-shot commands (`models list`/`sync`/`codex install`) by lazy-loading subcommand logic, and fix startup-blocking + per-request recomputation hazards found along the way.

**Architecture:** Split each Commander subcommand into a lightweight shell file (only imports `commander`, holds description/options for `--help`) and a `*-run.ts` logic file loaded via dynamic `import()` inside the action. Cut the `src/index.ts` barrel "light-use, heavy-pull" chain by having thin consumers import directly from source modules. Parallelize startup I/O (OAuth refresh, plugin load, auth-fetch build) and move OAuth status refresh off the port-listening critical path. Cache per-request recomputations (prefixed routes, ProxyAgent, model lists) at `createApp`/`createProviderRegistry` scope, valid because `settings` is immutable at runtime.

**Tech Stack:** TypeScript (ESM + NodeNext, `.js` import extensions), Hono, Vercel AI SDK (`@ai-sdk/*`), Commander v15, Vitest, pnpm, tsx, undici.

## Global Constraints

- All local imports MUST use `.js` extensions (ESM + `NodeNext`).
- `tsconfig.base.json` enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax` — optional fields use conditional spread (`...(x ? { x } : {})`), not `undefined` literals.
- Error-handling nodes (`catch`, error branches, fallbacks) MUST log with full object + stack (`logger.error({ err }, msg)`); never swallow errors silently.
- Logs auto-redact `apikey`/`api_key`/`authorization`/`x-api-key`/`proxy-authorization` (case-insensitive).
- Never commit `.env`, `settings.jsonc`, `auth.json`, or real API keys.
- JS/TS package manager is `pnpm`; tests are Vitest (`pnpm test`, no network); typecheck is `pnpm typecheck` (`tsc --noEmit`).
- `settings` is immutable at runtime (no hot-reload) — this is the correctness premise for all request-path caching in Layer C.
- `TokenManager.ensureValidToken` already has internal `refreshLocks` concurrency de-dup; request-path `createOAuthFetch` calls it independently per request, so startup pre-refresh is an optimization, not a correctness requirement.

## File Structure

**Layer A (CLI lazy-load):**

- `src/cli/context.ts` — modify: import directly from `env.js` + `resolve-settings-path.js` (bypass barrel).
- `src/cli/models/list.ts` — modify: becomes shell (only `commander`).
- `src/cli/models/list-run.ts` — create: `runModelsList` + render helpers + config/model-types imports.
- `src/cli/models/sync.ts` — modify: becomes shell.
- `src/cli/models/sync-run.ts` — create: `runModelsSync` + heavy deps.
- `src/cli/codex/install.ts` — modify: becomes shell.
- `src/cli/codex/install-run.ts` — create: `runCodexInstall` + heavy deps.

**Layer B (barrel direct-connect):** modify `src/server/stream-inspect.ts`, `src/server/oauth/startup.ts`, `src/server/oauth/callback.ts`, `src/server/types.ts`, `src/server/handle-protocol.ts`, `src/server/codex.ts`.

**Layer C (startup parallel + request cache):** modify `src/server/server.ts`, `src/server/app.ts`, `src/server/oauth/startup.ts`, `src/providers/registry.ts`, `src/providers/shared/provider-factory.ts`, `src/routing.ts`, `src/plugins/registry.ts`, `src/server/codex.ts`.

**Layer D (side effects):** modify `src/server/logging.ts`, `src/plugins/builtins/vendor-sse-error.ts`, `src/plugins/loader.ts`, `src/server/server.ts`, `src/index.ts`.

---

### Task 1: context.ts direct-connect (bypass barrel)

**Files:**

- Modify: `src/cli/context.ts:4`
- Test: `test/cli/context.test.ts` (create — minimal, asserts `resolveCliContext` returns paths)

**Interfaces:**

- Produces: `resolveCliContext()` unchanged signature; just lighter import graph.

- [ ] **Step 1: Write the failing test**

Create `test/cli/context.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveCliContext } from '../../src/cli/context.js'

describe('resolveCliContext', () => {
  it('returns rootDir and settingsPath pointing at config/settings.jsonc', () => {
    const ctx = resolveCliContext()
    expect(ctx.rootDir).toMatch(/llm-proxy-ts$/)
    expect(ctx.settingsPath.endsWith('config/settings.jsonc')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `pnpm test test/cli/context.test.ts`
Expected: PASS (function already works; this guards the import-graph change).

- [ ] **Step 3: Change context.ts imports**

In `src/cli/context.ts`, replace line 4:

```ts
// from
import { resolveSettingsPath, loadEnvironmentFiles } from '../index.js'
// to
import { resolveSettingsPath } from '../resolve-settings-path.js'
import { loadEnvironmentFiles } from '../env.js'
```

(`index.ts:26-27` re-exports these verbatim from `./env.js` and `./resolve-settings-path.js`.)

- [ ] **Step 4: typecheck + test**

Run: `pnpm typecheck && pnpm test test/cli/context.test.ts`
Expected: PASS, no type errors.

- [ ] **Step 5: Verify the speedup**

Run: `time ./node_modules/.bin/tsx src/cli/cli.ts models list`
Expected: ~1.1s → ~0.86s (list.js 325ms→12ms confirmed earlier).

- [ ] **Step 6: Commit**

```bash
git add src/cli/context.ts test/cli/context.test.ts
git commit -m "perf(cli): bypass barrel in context.ts to skip @ai-sdk load"
```

---

### Task 2: Split list.ts into shell + list-run.ts

**Files:**

- Modify: `src/cli/models/list.ts` (becomes shell)
- Create: `src/cli/models/list-run.ts`
- Modify: `test/cli/models-list.test.ts` (import path)

**Interfaces:**

- Consumes: `resolveCliContext` from `../context.js` (Task 1), `loadSettingsFromFile` from `../../config.js`, `enumerateModelEntries` from `../../providers/model-types.js`.
- Produces: `runModelsList` exported from `list-run.ts`; `createModelsListCommand` stays in `list.ts`.

- [ ] **Step 1: Create list-run.ts with the logic**

Create `src/cli/models/list-run.ts` containing everything currently in `list.ts` EXCEPT `createModelsListCommand`: `ModelsListOptions`, `ModelRow`, `collectRows`, `formatLimitNum`, `ROW_COL_DEFS`, `Prepared`, `prepare`, `renderRows`, `formatTable`, `runModelsList`. Top imports:

```ts
import { loadSettingsFromFile } from '../../config.js'
import type { AliasEntry, ModelRouteConfig, Settings } from '../../config.js'
import { enumerateModelEntries } from '../../providers/model-types.js'
```

Move `formatLimitNum`/`renderRows` exports here (test imports them).

- [ ] **Step 2: Reduce list.ts to a shell**

Replace entire `src/cli/models/list.ts` with:

```ts
import { Command } from 'commander'

export function createModelsListCommand(): Command {
  return new Command('list')
    .description('Display all configured models from settings')
    .action(async () => {
      const { runModelsList } = await import('./list-run.js')
      const { resolveCliContext } = await import('../context.js')
      const { settingsPath } = resolveCliContext()
      await runModelsList({ settingsPath })
    })
}
```

- [ ] **Step 3: Update test import path**

In `test/cli/models-list.test.ts`, change `from '../../src/cli/models/list.js'` → `from '../../src/cli/models/list-run.js'` for `formatLimitNum`/`renderRows`.

- [ ] **Step 4: typecheck + test**

Run: `pnpm typecheck && pnpm test test/cli/models-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify --help still shows the subcommand**

Run: `./node_modules/.bin/tsx src/cli/cli.ts models --help`
Expected: lists `list` and `sync` with descriptions.

- [ ] **Step 6: Commit**

```bash
git add src/cli/models/list.ts src/cli/models/list-run.ts test/cli/models-list.test.ts
git commit -m "refactor(cli): split list command into shell + lazy list-run"
```

---

### Task 3: Split sync.ts into shell + sync-run.ts

**Files:**

- Modify: `src/cli/models/sync.ts` (becomes shell)
- Create: `src/cli/models/sync-run.ts`

**Interfaces:**

- Produces: `runModelsSync` exported from `sync-run.ts`; `createModelsSyncCommand` stays in `sync.ts` with option declarations (`-p/--provider`, `--dry-run`) intact for `--help`.

- [ ] **Step 1: Create sync-run.ts with the logic**

Create `src/cli/models/sync-run.ts` containing `ModelsSyncOptions` and `runModelsSync` (lines 14-284 of current `sync.ts`), with the heavy top imports:

```ts
import * as clack from '@clack/prompts'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { loadSettingsFromFile } from '../../config.js'
import type { ModelRouteInput, Settings } from '../../config.js'
import { createTokenManagerIfNeeded } from '../../oauth/index.js'
import { PluginRegistry } from '../../plugins/registry.js'
import { applyMultipleProviderModels, writeSettingsFile } from './settings-writer.js'
import { discoverProviderModels, type ProviderModelsResult } from './discovery.js'
```

- [ ] **Step 2: Reduce sync.ts to a shell**

Replace entire `src/cli/models/sync.ts` with:

```ts
import { Command } from 'commander'

export function createModelsSyncCommand(): Command {
  return new Command('sync')
    .description('Discover and select models from upstream providers')
    .option('-p, --provider <name>', 'Skip provider selection, sync specific provider')
    .option('--dry-run', 'Preview changes without writing to settings')
    .action(async (opts) => {
      const { runModelsSync } = await import('./sync-run.js')
      const { resolveCliContext } = await import('../context.js')
      const { settingsPath } = resolveCliContext()
      const syncOpts: Parameters<typeof runModelsSync>[0] = {
        settingsPath,
        dryRun: opts.dryRun ?? false,
      }
      if (opts.provider !== undefined) syncOpts.provider = opts.provider
      await runModelsSync(syncOpts)
    })
}
```

- [ ] **Step 3: typecheck + test**

Run: `pnpm typecheck && pnpm test test/cli/`
Expected: PASS (discover-models.test.ts imports from `discovery.js`, unchanged).

- [ ] **Step 4: Verify --help shows options**

Run: `./node_modules/.bin/tsx src/cli/cli.ts models sync --help`
Expected: shows `-p, --provider <name>` and `--dry-run`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/models/sync.ts src/cli/models/sync-run.ts
git commit -m "refactor(cli): split sync command into shell + lazy sync-run"
```

---

### Task 4: Split install.ts into shell + install-run.ts

**Files:**

- Modify: `src/cli/codex/install.ts` (becomes shell)
- Create: `src/cli/codex/install-run.ts`
- Modify: `test/cli/codex-install.test.ts` (import path)

**Interfaces:**

- Produces: `runCodexInstall`, `buildCodexBaseUrl` (and any helpers the test imports) exported from `install-run.ts`; `createCodexInstallCommand` stays in `install.ts`.

- [ ] **Step 1: Create install-run.ts with the logic**

Read current `src/cli/codex/install.ts`. Move into `src/cli/codex/install-run.ts`: `runCodexInstall`, `buildCodexBaseUrl`, and every helper/type the test imports (check `test/cli/codex-install.test.ts` for exact symbols — at minimum `runCodexInstall` and `buildCodexBaseUrl`). Carry the heavy top imports verbatim (`@clack/prompts`, `node:fs/promises`, `../../codex-catalog.js`, `../../config.js`, `./home.js`, `./toml.js`, and any types).

- [ ] **Step 2: Reduce install.ts to a shell**

Replace entire `src/cli/codex/install.ts` with:

```ts
import { Command } from 'commander'

export function createCodexInstallCommand(): Command {
  return new Command('install')
    .description('Install llm-proxy as a codex model provider in ~/.codex/config.toml')
    .action(async () => {
      const { runCodexInstall } = await import('./install-run.js')
      const { resolveCliContext } = await import('../context.js')
      const { settingsPath } = resolveCliContext()
      await runCodexInstall({ settingsPath })
    })
}
```

- [ ] **Step 3: Update test import path**

In `test/cli/codex-install.test.ts`, change imports of `runCodexInstall`/`buildCodexBaseUrl` from `'../../src/cli/codex/install.js'` → `'../../src/cli/codex/install-run.js'`.

- [ ] **Step 4: typecheck + test**

Run: `pnpm typecheck && pnpm test test/cli/codex-install.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify --help + full CLI speed**

Run: `./node_modules/.bin/tsx src/cli/cli.ts codex --help && time ./node_modules/.bin/tsx src/cli/cli.ts models list`
Expected: `codex install` listed; `models list` still fast.

- [ ] **Step 6: Commit**

```bash
git add src/cli/codex/install.ts src/cli/codex/install-run.ts test/cli/codex-install.test.ts
git commit -m "refactor(cli): split codex install into shell + lazy install-run"
```

---

### Task 5: Barrel direct-connect for P0/P1 consumers

**Files:**

- Modify: `src/server/stream-inspect.ts:1-2`
- Modify: `src/server/oauth/startup.ts:1-3` (also touched by Task 7 — do the import change here, the function change in Task 7)
- Modify: `src/server/oauth/callback.ts:2-3`
- Modify: `src/server/types.ts:3-4,9`
- Modify: `src/server/handle-protocol.ts:3-6`
- Modify: `src/server/codex.ts:3-4`

**Interfaces:** No signature changes — pure import-source redirection (barrel re-exports are semantically identical to direct imports).

- [ ] **Step 1: stream-inspect.ts — type-only direct connect**

Replace lines 1-2:

```ts
// from
import type { ... } from '../index.js'   // Settings, ProviderConfig, ResolvedPlugin, ProxyPlugin, PluginResponse, Plugin
// to
import type { Settings, ProviderConfig } from '../config.js'
import type { ResolvedPlugin, ProxyPlugin, PluginResponse, Plugin } from '../plugins/types.js'
```

(Preserve the exact symbol list currently imported; split light `config.js` types from `plugins/types.js` types.)

- [ ] **Step 2: oauth/startup.ts — direct connect**

Replace lines 1-3:

```ts
// from
import type { Settings, OAuthConfig } from '../../index.js'
import { classifyStatus } from '../../index.js'
import type { TokenManager, AuthStatus } from '../../index.js'
// to
import type { Settings, OAuthConfig } from '../../config.js'
import { classifyStatus } from '../../oauth/token-manager.js'
import type { TokenManager } from '../../oauth/token-manager.js'
import type { AuthStatus } from '../../oauth/types.js'
```

(Verify `classifyStatus` lives in `token-manager.js` — if it's in `oauth/types.js`, import from there. Check `oauth/index.js` re-export source.)

- [ ] **Step 3: oauth/callback.ts — type-only direct connect**

Replace lines 2-3:

```ts
// from
import type { Settings, OAuthConfig } from '../../index.js'
import type { TokenManager } from '../../index.js'
// to
import type { Settings, OAuthConfig } from '../../config.js'
import type { TokenManager } from '../../oauth/token-manager.js'
```

- [ ] **Step 4: types.ts — type-only direct connect**

Replace lines 3-4 (and line 9 re-export):

```ts
// from
import type {
  Settings,
  TokenManager,
  ProviderRegistry,
  PluginRegistry,
  KeySelection,
} from '../index.js'
// to
import type { Settings } from '../config.js'
import type { TokenManager } from '../oauth/token-manager.js'
import type { ProviderRegistry, KeySelection } from '../providers/registry.js'
import type { PluginRegistry } from '../plugins/registry.js'
```

Line 9 `export type { Settings } from '../index.js'` → `export type { Settings } from '../config.js'`.

- [ ] **Step 5: handle-protocol.ts — mixed direct connect**

Replace lines 3-6 (value + type imports). Read the current import block to get exact symbols, then split by source:

```ts
import { OAuthError } from '../oauth/types.js'
import { RoutingError } from '../routing.js'
import { flattenUsage } from '../providers/shared/renderer-utils.js'
import { collectStreamResult } from '../providers/shared/stream-collector.js'
import type { ProtocolStrategy, ProtocolErrorFormatter } from '../providers/shared/strategy.js'
import type { AISDKInput } from '../providers/openai-compatible/protocol.js' // verify source via index.ts:88
import type { Settings } from '../config.js'
import type { RoutingTable } from '../routing.js'
import type { ResolvedPlugin } from '../plugins/registry.js'
```

**Verify `AISDKInput`'s actual definition source:** `index.ts:88` re-exports it from `./providers/openai-compatible/protocol.js`. If the symbol is actually defined in `providers/shared/aisdk-types.js` and re-exported, import from the definition source. Confirm by grepping `export.*AISDKInput` under `src/providers/`.

- [ ] **Step 6: codex.ts — direct connect**

Replace lines 3-4:

```ts
// from
import { openaiResponsesStrategy } from '../index.js'
import type { Settings } from '../index.js'
// to
import { openaiResponsesStrategy } from '../providers/openai-responses/strategy.js'
import type { Settings } from '../config.js'
```

- [ ] **Step 7: typecheck + full test**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/server/stream-inspect.ts src/server/oauth/startup.ts src/server/oauth/callback.ts src/server/types.ts src/server/handle-protocol.ts src/server/codex.ts
git commit -m "refactor: direct-connect barrel consumers to skip transitive @ai-sdk load"
```

---

### Task 6: Side-effect cleanup (Layer D)

**Files:**

- Modify: `src/server/logging.ts` (move `cleanOldLogs()` call into `createLogger` with a guard)
- Modify: `src/plugins/builtins/vendor-sse-error.ts:96` (remove top-level `registerBuiltInPlugin`)
- Modify: `src/plugins/loader.ts` (static `builtInPlugins` Map)
- Modify: `src/index.ts:73` (remove `registerBuiltInPlugin` export)
- Modify: `src/server/server.ts:127-133` (move `process.on` into `start()`)

**Interfaces:**

- `registerBuiltInPlugin` removed from public API; `getBuiltInPlugin` now reads a static Map.
- `logger` export unchanged.

- [ ] **Step 1: logging.ts — defer cleanOldLogs**

Read `src/server/logging.ts`. The module top-level calls `cleanOldLogs()` (line ~228) and `export const logger = createLogger()` (line ~225-227). Remove the top-level `cleanOldLogs()` call. Inside `createLogger`, add a module-scoped `let cleaned = false` guard and call `cleanOldLogs()` once on first `createLogger` invocation (before building the logger). `mkdirSync` already inside `createLogger` stays.

- [ ] **Step 2: vendor-sse-error.ts — remove top-level registration**

Read `src/plugins/builtins/vendor-sse-error.ts`. Remove the top-level `registerBuiltInPlugin(vendorSseErrorPlugin)` call (line ~96). Keep the `vendorSseErrorPlugin` export and `inspectVendorSseError` export.

- [ ] **Step 3: loader.ts — static builtInPlugins Map**

Read `src/plugins/loader.ts`. Replace the runtime `builtInPlugins = new Map()` + `registerBuiltInPlugin`/`getBuiltInPlugin` API with a static initialization:

```ts
import { vendorSseErrorPlugin } from './builtins/vendor-sse-error.js'
// ...
const builtInPlugins: ReadonlyMap<string, Plugin> = new Map([
  ['vendor_sse_error', vendorSseErrorPlugin],
])
export function getBuiltInPlugin(name: string): Plugin | undefined {
  return builtInPlugins.get(name)
}
```

Remove `registerBuiltInPlugin` export. Confirm no other code calls `registerBuiltInPlugin` (grep).

- [ ] **Step 4: index.ts — drop registerBuiltInPlugin export**

In `src/index.ts`, remove line 73 `export { registerBuiltInPlugin } from './plugins/loader.js'` (keep `loadPlugin` export on that line if combined — split carefully). Keep `getBuiltInPlugin` unexported (internal) unless something currently imports it from the barrel — grep to confirm.

- [ ] **Step 5: server.ts — move process.on into start()**

In `src/server/server.ts`, move the two top-level `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` (lines 127-133) into the `start()` function body (before the `try { await main() }`).

- [ ] **Step 6: typecheck + test**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. Pay attention to `test/routing.test.ts` and any plugin test that relied on the side-effect registration — if a test now fails because `vendor_sse_error` isn't registered, add an explicit `import` of `vendor-sse-error.js` in that test (the static Map makes registration unnecessary, but the import is harmless and keeps the test self-contained).

- [ ] **Step 7: Commit**

```bash
git add src/server/logging.ts src/plugins/builtins/vendor-sse-error.ts src/plugins/loader.ts src/index.ts src/server/server.ts
git commit -m "refactor: remove module top-level side effects (log cleanup, plugin self-register, global handlers)"
```

---

### Task 7: Startup parallelization (H1/H2/M5/M6)

**Files:**

- Modify: `src/server/oauth/startup.ts` (add `refreshAuthStatuses`)
- Modify: `src/server/server.ts` (non-blocking refresh, parallel plugin/registry)
- Modify: `src/server/app.ts` (`authStatuses` → `getAuthStatuses` getter)
- Modify: `src/server/types.ts` (`AppDependencies.authStatuses` → `getAuthStatuses`)
- Modify: `src/providers/registry.ts:107-114` (parallel `createAuthFetch`)
- Modify: `src/plugins/registry.ts` (parallel `fromSettings`/`initAll`/`afterServerStartAll`, cache `allResolved`)

**Interfaces:**

- `AppDependencies`: `authStatuses?: ProviderAuthStatus[]` → `getAuthStatuses?: () => ProviderAuthStatus[]`.
- `refreshAuthStatuses(settings, tokenManager): Promise<ProviderAuthStatus[]>` — new export.
- `validateOAuthStatus` kept for `startup.test.ts` compatibility.

- [ ] **Step 1: Add refreshAuthStatuses (parallel, non-throwing)**

In `src/server/oauth/startup.ts`, add:

```ts
export async function refreshAuthStatuses(
  settings: Settings,
  tokenManager: TokenManager,
): Promise<ProviderAuthStatus[]> {
  const oauthProviders = Object.entries(settings.providers).filter(([, p]) => p.oauth)
  const settled = await Promise.allSettled(
    oauthProviders.map(async ([name, provider]) => {
      const oauth = provider.oauth!
      const status = tokenManager.getStatus(name, oauth)
      if (status === 'valid') {
        logger.info({ provider: name }, 'oauth token valid')
        return { provider: name, status: 'valid' as const }
      }
      if (status === 'needs_refresh') {
        try {
          await tokenManager.ensureValidToken(name, oauth)
          logger.info({ provider: name }, 'oauth token refreshed')
          return { provider: name, status: 'valid' as const }
        } catch (err) {
          const loginUrl = buildLoginUrl(settings, name)
          logger.warn(
            { provider: name, loginUrl, err },
            'oauth token refresh failed — login required',
          )
          return { provider: name, status: 'needs_login', loginUrl }
        }
      }
      const loginUrl = buildLoginUrl(settings, name)
      logger.warn(
        { provider: name, loginUrl },
        'oauth login required — visit the URL to authenticate',
      )
      return { provider: name, status: 'needs_login', loginUrl }
    }),
  )
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          provider: oauthProviders[i]![0],
          status: 'needs_login' as const,
          loginUrl: buildLoginUrl(settings, oauthProviders[i]![0]),
        },
  )
}
```

Keep `validateOAuthStatus` (used by `startup.test.ts`).

- [ ] **Step 2: AppDependencies — getter instead of snapshot**

In `src/server/types.ts`, change `authStatuses?: ProviderAuthStatus[]` → `getAuthStatuses?: () => ProviderAuthStatus[]` (import `ProviderAuthStatus` from `./oauth/startup.js`). In `src/server/app.ts`:

- Destructure `getAuthStatuses` instead of `authStatuses`.
- `/health` handler: replace `if (authStatuses && authStatuses.length > 0)` with:

```ts
const authStatuses = getAuthStatuses?.() ?? []
if (authStatuses.length > 0) {
  /* existing mapping */
}
```

- [ ] **Step 3: server.ts — non-blocking refresh + getter wiring**

In `src/server/server.ts` `main()`:

- Replace lines 56-59 (`if (tokenManager) { authStatuses = await validateOAuthStatus(...) }`) with a mutable container + background refresh:

```ts
let authStatuses: ProviderAuthStatus[] = []
if (tokenManager) {
  refreshAuthStatuses(settings, tokenManager)
    .then((s) => {
      authStatuses = s
    })
    .catch((err) => logger.error({ err }, 'oauth status refresh failed'))
}
```

- In the `createApp({...})` call, replace `...(authStatuses ? { authStatuses } : {})` with `getAuthStatuses: () => authStatuses`.
- Import `refreshAuthStatuses` (keep `validateOAuthStatus` import only if still referenced — remove if not).

- [ ] **Step 4: registry.ts — parallel createAuthFetch**

In `src/providers/registry.ts` (lines ~107-114), replace the serial `for...of`:

```ts
const authFetchMap = new Map<string, (baseFetch?: typeof fetch) => typeof fetch>()
if (pluginRegistry) {
  const entries = Object.keys(settings.providers)
  const results = await Promise.all(
    entries.map(async (id) => {
      const af = await pluginRegistry.createAuthFetch(id, log, authFilePath)
      return [id, af] as const
    }),
  )
  for (const [id, af] of results) if (af) authFetchMap.set(id, af)
}
```

- [ ] **Step 5: plugins/registry.ts — cache allResolved + parallel lifecycle**

Read `src/plugins/registry.ts`. Three changes:

1. `allResolved()` (lines ~314-343): compute once in the constructor, store as `private readonly allResolvedCache: ResolvedPlugin[]`; `allResolved()` returns it.
2. `initAll` (lines ~187-203): change serial `for...of await` to `Promise.allSettled` over `this.allResolved()`. Preserve per-plugin error logging (collect rejected reasons, log each).
3. `afterServerStartAll` (lines ~215-221): same → `Promise.allSettled`.
4. `beforeServerStartAll` (lines ~206-212): **keep serial** (semantic ordering required).
5. `fromSettings` (lines ~100-182): parallelize the three layers with `Promise.all` / nested `Promise.all`. Move `log.info` calls to after each `Promise.all` completes (preserve log message text, accept that order within a layer is now nondeterministic — that's fine).

- [ ] **Step 6: typecheck + test**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. `test/server/oauth/startup.test.ts` still passes (validateOAuthStatus kept). If any test asserts serial ordering of plugin init, update it to assert completion rather than order.

- [ ] **Step 7: Commit**

```bash
git add src/server/oauth/startup.ts src/server/server.ts src/server/app.ts src/server/types.ts src/providers/registry.ts src/plugins/registry.ts
git commit -m "perf: parallelize startup (oauth refresh non-blocking, plugin load, auth-fetch)"
```

---

### Task 8: Request-path caching (H3/H4/M1/M2)

**Files:**

- Modify: `src/routing.ts` (prefixedRoutes cache)
- Modify: `src/providers/shared/provider-factory.ts` (accept proxyFetch instead of proxySettings)
- Modify: `src/providers/registry.ts` (sharedProxyFetch at registry scope)
- Modify: `src/server/codex.ts` (cache buildCodexModelsResponse)
- Modify: `src/server/app.ts` (cache listModels/getModel)
- Test: `test/routing.test.ts` (prefixed cache), `test/providers/registry.test.ts` (ProxyAgent singleton)

**Interfaces:**

- `applyProviderAuth` signature: `proxySettings` param → `proxyFetch: typeof fetch | undefined`.
- `createOpenAICompatibleProvider`/`createAnthropicProvider`/`createOpenAIProvider`: `settings` param dropped if only used for `settings.proxy`; accept `proxyFetch` instead (check each — some may still need `settings` for other fields).
- `RoutingTable.resolve()`: unchanged signature; internal cache.

- [ ] **Step 1: routing.ts — prefixedRoutes cache**

In `src/routing.ts`:

- Add `private readonly prefixedRoutes: Map<string, RouteMatch>` to the constructor params.
- In `fromSettings`, build it in the existing `enumerateModelEntries` loop (lines 53-92). For each entry, after `buildRoute(...)` for `${providerName}/${modelKey}`, store into `prefixedRoutes`. For each alias, store `buildRoute(providerName, provider, modelKey, \`${providerName}/${alias.name}\`, pluginRegistry)`under key`${providerName}/${alias.name}`. (The route for modelKey and its aliases shares the same `resolvedPlugins`/headers except `modelSelector`— build once per selector or reuse; simplest: call`buildRoute` per selector key.)
- In `resolve()`, replace the prefixed branch (lines 129-148): split selector, then `const route = this.prefixedRoutes.get(selector); if (route) return route;` — fall through to the existing provider-not-found / unknown-model errors. Remove the per-request `buildRoute` + alias linear scan.
- Keep `Object.keys(this.settings.providers).length` empty check (or precompute `providerCount`).

- [ ] **Step 2: routing cache test**

Add to `test/routing.test.ts`:

```ts
it('caches prefixed routes — resolve returns same RouteMatch instance for repeated selectors', () => {
  const settings = /* minimal settings with one provider/model + alias */
  const table = RoutingTable.fromSettings(settings)
  const a = table.resolve('prov/model')
  const b = table.resolve('prov/model')
  expect(a).toBe(b)  // same cached instance
  const aliasHit = table.resolve('prov/aliasName')
  expect(aliasHit.modelKey).toBe('model')
})
```

- [ ] **Step 3: provider-factory.ts — accept proxyFetch**

In `src/providers/shared/provider-factory.ts`:

- `applyProviderAuth`: change `proxySettings: { url: string; verify: boolean } | null` → `proxyFetch: typeof fetch | undefined`:

```ts
export function applyProviderAuth(
  options: { apiKey?: string; fetch?: typeof fetch },
  selectedApiKey: string | undefined,
  customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
  proxyFetch: typeof fetch | undefined,
): void {
  if (selectedApiKey !== undefined) options.apiKey = selectedApiKey
  if (selectedApiKey === undefined && customFetch) options.apiKey = 'oauth-placeholder'
  if (customFetch) {
    options.fetch = proxyFetch ? customFetch(proxyFetch) : customFetch()
  } else if (proxyFetch) {
    options.fetch = proxyFetch
  }
}
```

- `createOpenAICompatibleProvider`: drop `settings` param if it was only used for `settings.proxy`; add `proxyFetch: typeof fetch | undefined` param; call `applyProviderAuth(options, selectedApiKey, customFetch, proxyFetch)`. Do the same for `createAnthropicProvider` and `createOpenAIProvider` (read `src/providers/anthropic/provider.ts` and `src/providers/openai/provider.ts` to apply the same pattern — they currently pass `settings.proxy`).
- `createProxyFetch` stays (now called once at registry scope, not per request).

- [ ] **Step 4: registry.ts — sharedProxyFetch singleton**

In `src/providers/registry.ts` `createProviderRegistry`, before the return, build once:

```ts
const sharedProxyFetch = settings.proxy
  ? createProxyFetch(settings.proxy.url, settings.proxy.verify)
  : undefined
```

Import `createProxyFetch` from `./shared/provider-factory.js`. In `languageModel()`, pass `sharedProxyFetch` to each `createXxxProvider` call instead of having them read `settings.proxy`. Update `createProviderModelFactory` (read it — it wraps the three provider factories) to thread `proxyFetch` through instead of `settings`.

- [ ] **Step 5: ProxyAgent singleton test**

Add to `test/providers/registry.test.ts` a test that mocks `undici`'s `ProxyAgent` (vi.mock) and asserts the constructor is called exactly once when `languageModel` is called multiple times with a proxy-configured provider. If mocking undici is fragile, instead assert that `createProxyFetch` is called once by spying on it via module mock, or test `applyProviderAuth` directly: two calls share the same `proxyFetch` reference.

- [ ] **Step 6: codex.ts — cache buildCodexModelsResponse**

In `src/server/codex.ts` `createCodexApp`, add a closure cache for the `/v1/models` response:

```ts
let cachedModels: { models: CodexModelInfo[] } | null = null
// in the GET /v1/models handler:
if (!cachedModels) {
  const catalog = await catalogCache.get()
  cachedModels = buildCodexModelsResponse(settings, catalog)
}
return c.json(cachedModels)
```

(Preserve existing error handling around `catalogCache.get()` + `buildCodexModelsResponse` — the cache only stores the success result.)

- [ ] **Step 7: app.ts — cache listModels/getModel**

In `src/server/app.ts` `createApp`, precompute once:

```ts
const modelsList = listModels(settings)
const modelsById = new Map<string, ReturnType<typeof getModel>>()
for (const entry of enumerateModelEntries(settings)) {
  for (const id of entry.ids) {
    const m = getModel(settings, id)
    if (m) modelsById.set(id, m)
  }
}
```

Import `enumerateModelEntries` from `../providers/model-types.js`. Change `/v1/models` handler to `c.json(modelsList)`. Change `/v1/models/*` handler to look up `modelsById.get(modelId)` first; fall back to `getModel(settings, modelId)` only if not in map (defensive — should always be in map).

- [ ] **Step 8: typecheck + full test**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. Check `test/routing.test.ts`, `test/providers/registry.test.ts`, `test/server/models-endpoint.test.ts`, `test/server/app.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/routing.ts src/providers/shared/provider-factory.ts src/providers/registry.ts src/server/codex.ts src/server/app.ts test/routing.test.ts test/providers/registry.test.ts
git commit -m "perf: cache per-request recomputations (prefixed routes, ProxyAgent, model lists)"
```

---

## Self-Review

**1. Spec coverage:**

- CLI lazy-load (Layer A): Tasks 1-4 cover context.ts + list/sync/install splits. ✅
- Barrel direct-connect (Layer B): Task 5 covers all 6 P0/P1 consumers. ✅
- Side effects (Layer D): Task 6 covers logging/vendor-sse-error/loader/server. ✅
- Startup parallelization (H1/H2/M5/M6): Task 7. ✅
- Request caching (H3/H4/M1/M2): Task 8. ✅
- Deliberately deferred (L4-L7 micro-overheads, index.ts sub-barrel split): documented in plan-lazy-flamingo.md, not tasked — correct.

**2. Placeholder scan:** No "TBD"/"implement later". Where exact code depends on reading a file the controller hasn't fully read (install.ts helpers, anthropic/openai provider factories, plugins/registry.ts line ranges), the step says "read X, then apply pattern Y" with the pattern shown concretely — acceptable for a refactor where the edit is mechanical once the file is seen.

**3. Type consistency:**

- `getAuthStatuses: () => ProviderAuthStatus[]` used consistently in Task 7 (types.ts define, app.ts consume, server.ts wire).
- `applyProviderAuth` proxyFetch signature consistent across provider-factory.ts (define) and registry.ts (call) in Task 8.
- `refreshAuthStatuses` export name consistent in startup.ts (define) and server.ts (import).

## Verification (end-to-end)

After all 8 tasks:

- `pnpm typecheck && pnpm test` — all green.
- `time pnpm dev models list` — ~1.5s → ~0.95s; `./node_modules/.bin/tsx src/cli/cli.ts models list` → ~0.65s.
- `pnpm dev --help` / `models --help` / `models sync --help` / `codex --help` — all subcommands + options render.
- `pnpm dev models list` / `models sync --dry-run` / `codex install` execute without crash.
- Start server with an OAuth provider configured: port listens immediately; `/health` populates `auth` within ~1s.
- Repeated `/v1/models`, `/codex/v1/models`, and prefixed-route requests show stable latency (cached).
