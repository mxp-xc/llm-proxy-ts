# codex install CLI 子命令 Implementation Plan

> **实现后记（2026-06-25）**：本 plan 已实现并 squash 合并到 main（commit `358b919`）。相对 plan 的调整：
> 1. **code-review max 修复 11 项**：TOML 编辑器加固（表头带注释→重复表、read regex 捕获行内注释→读值损坏、控制字符转义、混合换行）；`normalizeTomlString`/`normalizeValue` 对称化修复幂等性误报；非 503 错误消费 response body；`catalogFilename` 复用单一常量；`defaultFs` 改静态 import；删死类型 `CodexModelsResponse`；校验 `selectModel` 返回 slug ∈ models；修复测试 `delete process.env` 泄漏。
> 2. **rebase onto main 重构（`72d19dd`）**：codex schemas 从 `config.ts` 迁至叶子模块 `codex-types.ts`，`codex-install.ts` 的 `codexModelInfoSchema`/`CodexModelInfo` 改从 `'../codex-types.js'` import（`Settings`/`loadSettingsFromFile` 仍从 `'../config.js'`）。
>
> 最终：472 tests green，typecheck clean。**代码是 source of truth**；本文档记录开发设计。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `codex install` CLI 子命令，一键把本代理 `/codex/v1/models` 的 catalog 安装到 codex（写 catalog 文件 + 配置 `~/.codex/config.toml` 的 `model_catalog_json` / `model_provider` / `model` / `[model_providers.llm-proxy]`），让 codex 装完即用。

**Architecture:** Commander.js `codex` 命令组 + `install` 子命令。业务逻辑抽成可注入纯函数 `runCodexInstall`（仿 `runModelsSync` 的 clack 编排）。TOML 修改用无依赖纯文本行编辑（保留用户注释/格式，不引入 TOML 库），核心纯函数 `setTopLevelKey`/`setProviderTable` 可独立测试。catalog 文件格式与 `/codex/v1/models` 端点返回完全一致（`{models:[...]}`），原样存。

**Tech Stack:** TypeScript (ESM/NodeNext), Commander.js v15, @clack/prompts, zod (v3 子路径), vitest, node:fs/promises, node:os, node:path。

## Global Constraints

- **导入**：所有本地导入必须用 `.js` 扩展名（ESM + NodeNext）。
- **TS 严格**：`noUncheckedIndexedAccess`（索引访问需 null 检查或 `!`）、`exactOptionalPropertyTypes`（可选字段用 `field?: T`，不在可选位传 `undefined`）、`verbatimModuleSyntax`（仅类型导入用 `import type`）。
- **zod**：项目用 zod 4，但 codex 相关 schema 在 `src/codex-types.ts`（重构后）用 `zod/v3` 子路径。新 schema 用 `import { z } from 'zod/v3'`，并复用 `codex-types.ts` 导出的 `codexModelInfoSchema`。**禁止**用 `unknown` 作入参/返回值（错误处理 catch 体例外）。
- **日志/错误**：错误处理节点必须记日志不得静默。CLI 用 `@clack/prompts`（`clack.log.error`/`clack.log.warn`）+ `clack.outro('Aborted')` + `return`，不用 pino（pino 仅服务端）。每个 `clack.select` 后必须 `clack.isCancel` 检查 → `clack.cancel` + `return`。
- **测试**：vitest，无网络。业务逻辑抽纯函数 + 注入 `fetchImpl`/`fs`/`prompts` + `test/helpers/temp-file.ts` 的 `createTempDir`。不测 Commander 层。
- **缩进**：2 空格。catalog 文件用 `JSON.stringify(res, null, 2)`。
- **固定值**：catalog 文件名 `llm-proxy-model-catalog.json`；provider id `llm-proxy`；provider `name = "LLM Proxy"`；`wire_api = "responses"`；`model_catalog_json` 值用文件名形式（相对 `~/.codex` 解析）；`base_url = "http://{host}:{port}/codex/v1"`（无 trailing slash；host 含 `:` 时用 `[host]`）。
- **config.toml**：不存在则报错退出，**绝不创建**。`$CODEX_HOME` 默认 `~/.codex`（`os.homedir()`），尊重 `process.env.CODEX_HOME`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/cli/toml-editor.ts` | Create | 无依赖 TOML 行编辑纯函数（string→string，保留注释/EOL） |
| `src/cli/codex-home.ts` | Create | codex home / config / catalog 路径解析纯函数 |
| `src/cli/codex-toml.ts` | Create | `applyCodexConfigEdits` 编排 4 处编辑 + 覆盖报告 |
| `src/cli/codex-install.ts` | Create | `runCodexInstall` + `buildCodexBaseUrl` + `fetchCodexModelsResponse` + `createCodexInstallCommand` |
| `src/cli/codex.ts` | Create | `codex` 命令组 |
| `src/cli/cli.ts` | Modify | 注册 `createCodexCommand` |
| `test/cli/toml-editor.test.ts` | Create | toml-editor 纯函数边界测试 |
| `test/cli/codex-home.test.ts` | Create | codex-home 路径解析测试 |
| `test/cli/codex-toml.test.ts` | Create | applyCodexConfigEdits 编排 + 幂等测试 |
| `test/cli/codex-install.test.ts` | Create | runCodexInstall 端到端（注入 fetch/fs/prompts + temp dir） |

复用现有：`codex-types.ts` 的 `codexModelInfoSchema`/`CodexModelInfo`；`config.ts` 的 `Settings`/`loadSettingsFromFile`；`src/cli/context.ts` 的 `resolveCliContext`；`test/helpers/temp-file.ts` 的 `createTempDir`；`test/helpers/settings.ts` 的 `makeSettings`。无新依赖。

---

### Task 1: toml-editor.ts — TOML 行编辑纯函数

**Files:**
- Create: `src/cli/toml-editor.ts`
- Test: `test/cli/toml-editor.test.ts`

**Interfaces:**
- Consumes: 无（无依赖纯函数）
- Produces: `formatTomlString`, `formatTomlBool`, `formatTableHeaderPath`, `setTopLevelKey`, `setProviderTable`, `readTopLevelKey`, `readProviderTableField`（供 Task 3 的 `applyCodexConfigEdits` 使用）

- [ ] **Step 1: 写失败测试 `test/cli/toml-editor.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import {
  formatTomlString,
  formatTomlBool,
  formatTableHeaderPath,
  setTopLevelKey,
  setProviderTable,
  readTopLevelKey,
  readProviderTableField,
} from '../../src/cli/toml-editor.js'

describe('formatTomlString', () => {
  it('wraps in double quotes and escapes backslash/quote', () => {
    expect(formatTomlString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
  it('plain value', () => {
    expect(formatTomlString('llm-proxy-model-catalog.json')).toBe('"llm-proxy-model-catalog.json"')
  })
})

describe('formatTomlBool', () => {
  it('true/false', () => {
    expect(formatTomlBool(true)).toBe('true')
    expect(formatTomlBool(false)).toBe('false')
  })
})

describe('formatTableHeaderPath', () => {
  it('bare keys joined by dot', () => {
    expect(formatTableHeaderPath(['model_providers', 'llm-proxy'])).toBe('model_providers.llm-proxy')
  })
  it('non-bare key quoted', () => {
    expect(formatTableHeaderPath(['model_providers', 'weird id'])).toBe('model_providers."weird id"')
  })
})

describe('setTopLevelKey', () => {
  it('inserts into empty file with trailing newline', () => {
    expect(setTopLevelKey('', 'model', formatTomlString('glm-5.2'))).toBe('model = "glm-5.2"\n')
  })
  it('replaces existing root key, preserves leading comment', () => {
    const content = '# my model\nmodel = "gpt-5"\n'
    expect(setTopLevelKey(content, 'model', formatTomlString('glm-5.2')))
      .toBe('# my model\nmodel = "glm-5.2"\n')
  })
  it('inserts before first table with blank separator', () => {
    const content = '[model_providers.openai]\nname = "OpenAI"\n'
    const out = setTopLevelKey(content, 'model', formatTomlString('glm-5.2'))
    expect(out).toBe('model = "glm-5.2"\n\n[model_providers.openai]\nname = "OpenAI"\n')
  })
  it('does not touch same-named key inside a table', () => {
    const content = '[foo]\nmodel = "x"\n'
    const out = setTopLevelKey(content, 'model', formatTomlString('glm-5.2'))
    expect(out).toBe('model = "glm-5.2"\n\n[foo]\nmodel = "x"\n')
  })
  it('appends at EOF when no table and key missing', () => {
    const content = 'model_provider = "openai"\n'
    const out = setTopLevelKey(content, 'model', formatTomlString('glm-5.2'))
    expect(out).toBe('model_provider = "openai"\nmodel = "glm-5.2"\n')
  })
  it('preserves CRLF line endings', () => {
    const content = 'model = "gpt-5"\r\n'
    expect(setTopLevelKey(content, 'model', formatTomlString('glm-5.2'))).toBe('model = "glm-5.2"\r\n')
  })
})

describe('setProviderTable', () => {
  const fields = { name: 'LLM Proxy', base_url: 'http://127.0.0.1:8056/codex/v1', wire_api: 'responses' }
  it('appends new table at EOF with leading blank line', () => {
    const content = 'model = "glm-5.2"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    expect(out).toBe(
      'model = "glm-5.2"\n\n[model_providers.llm-proxy]\nname = "LLM Proxy"\nbase_url = "http://127.0.0.1:8056/codex/v1"\nwire_api = "responses"\n',
    )
  })
  it('replaces existing table body wholesale, dropping extra fields', () => {
    const content = '[model_providers.llm-proxy]\nname = "old"\nenv_key = "X"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    expect(out).toBe(
      '[model_providers.llm-proxy]\nname = "LLM Proxy"\nbase_url = "http://127.0.0.1:8056/codex/v1"\nwire_api = "responses"\n',
    )
    expect(out).not.toContain('env_key')
  })
  it('stops at next table header', () => {
    const content = '[model_providers.llm-proxy]\nname = "old"\n[model_providers.openai]\nname = "OpenAI"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    expect(out).toContain('[model_providers.openai]\nname = "OpenAI"')
    expect(out).not.toContain('name = "old"')
  })
  it('does not match array-of-tables [[...]]', () => {
    const content = '[[model_providers.llm-proxy]]\nname = "old"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    expect(out).toContain('[[model_providers.llm-proxy]]\nname = "old"')
    expect(out).toContain('[model_providers.llm-proxy]\nname = "LLM Proxy"')
  })
})

describe('readTopLevelKey', () => {
  it('reads root value', () => {
    expect(readTopLevelKey('model = "glm-5.2"\n', 'model')).toBe('glm-5.2')
  })
  it('returns undefined when missing', () => {
    expect(readTopLevelKey('model_provider = "x"\n', 'model')).toBeUndefined()
  })
  it('does not read key inside table', () => {
    expect(readTopLevelKey('[foo]\nmodel = "x"\n', 'model')).toBeUndefined()
  })
})

describe('readProviderTableField', () => {
  it('reads field from target table', () => {
    const content = '[model_providers.llm-proxy]\nname = "LLM Proxy"\nbase_url = "http://x/codex/v1"\n'
    expect(readProviderTableField(content, 'llm-proxy', 'base_url')).toBe('http://x/codex/v1')
  })
  it('returns undefined when table missing', () => {
    expect(readProviderTableField('model = "x"\n', 'llm-proxy', 'base_url')).toBeUndefined()
  })
  it('returns undefined when field missing', () => {
    const content = '[model_providers.llm-proxy]\nname = "LLM Proxy"\n'
    expect(readProviderTableField(content, 'llm-proxy', 'base_url')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/cli/toml-editor.test.ts`
Expected: FAIL（模块不存在 / 导入报错）

- [ ] **Step 3: 实现 `src/cli/toml-editor.ts`**

```typescript
/** TOML bare key: letters, digits, A-Z a-z 0-9 _ - */
function isBareKey(segment: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(segment)
}

/** Format a string as a TOML basic string literal (double-quoted, escaped). */
export function formatTomlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

/** Format a boolean as a TOML bool. */
export function formatTomlBool(value: boolean): string {
  return value ? 'true' : 'false'
}

/** Format an array of key segments as a TOML dotted table header path. */
export function formatTableHeaderPath(segments: string[]): string {
  return segments.map((s) => (isBareKey(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join('.')
}

type FieldValue = string | boolean

function formatFieldValue(value: FieldValue): string {
  return typeof value === 'boolean' ? formatTomlBool(value) : formatTomlString(value)
}

/** Detect the dominant line ending of the content (default \n). */
function detectEol(content: string): string {
  const crlf = content.includes('\r\n')
  return crlf ? '\r\n' : '\n'
}

/** Split content into lines without their trailing newline. */
function splitLines(content: string, eol: string): string[] {
  if (content === '') return []
  const stripped = content.endsWith(eol) ? content.slice(0, -eol.length) : content
  return stripped.split(eol)
}

function joinLines(lines: string[], eol: string): string {
  if (lines.length === 0) return ''
  return lines.join(eol) + eol
}

/** Index of the first table header line ([table] or [[table]]), or lines.length if none. */
function findFirstTableLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) return i
  }
  return lines.length
}

/** True if a line is a table header (starts with [ ), including array-of-tables [[. */
function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line)
}

/** True if a line declares `key =` at root (matched against the given key). */
function matchesRootKey(line: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${escaped}\\s*=`).test(line)
}

/** Set (insert or replace) a top-level key. Insertion lands before the first table. */
export function setTopLevelKey(content: string, key: string, value: string): string {
  const eol = detectEol(content)
  const lines = splitLines(content, eol)
  const firstTable = findFirstTableLine(lines)
  const newLine = `${key} = ${value}`

  // Replace existing root key (search only in root region).
  for (let i = 0; i < firstTable; i++) {
    if (matchesRootKey(lines[i]!, key)) {
      const indent = (lines[i]!.match(/^\s*/) ?? [''])[0]
      lines[i] = `${indent}${key} = ${value}`
      return joinLines(lines, eol)
    }
  }

  // Insert before first table (or at EOF). Keep a blank separator before a table.
  if (firstTable < lines.length) {
    const insertAt = firstTable
    const prev = lines[insertAt - 1]
    if (prev === undefined) {
      // Table is the first line: key, blank, then table.
      lines.splice(insertAt, 0, newLine, '')
    } else if (prev.trim() !== '') {
      // Previous line has content: separate with a blank line.
      lines.splice(insertAt, 0, '', newLine)
    } else {
      // Previous line is already blank.
      lines.splice(insertAt, 0, newLine)
    }
  } else {
    // Append at EOF.
    lines.push(newLine)
  }
  return joinLines(lines, eol)
}

/** Header line for a model_providers.<id> table (flat, not array). */
function providerHeaderLine(providerId: string): string {
  return `[${formatTableHeaderPath(['model_providers', providerId])}]`
}

/** True if line is exactly the target provider table header (flat, not [[ ]]). */
function isProviderHeader(line: string, header: string): boolean {
  const trimmed = line.trim()
  if (trimmed.startsWith('[[')) return false // array-of-tables excluded
  return trimmed === header
}

/** Set (create or replace) the [model_providers.<id>] table with exactly the given fields. */
export function setProviderTable(
  content: string,
  providerId: string,
  fields: Record<string, FieldValue>,
): string {
  const eol = detectEol(content)
  const lines = splitLines(content, eol)
  const header = providerHeaderLine(providerId)
  const bodyLines = Object.entries(fields).map(([k, v]) => `${k} = ${formatFieldValue(v)}`)

  // Find existing target table range.
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (isProviderHeader(lines[i]!, header)) {
      start = i
      break
    }
  }

  if (start >= 0) {
    // Find end: next table header or EOF.
    let end = lines.length
    for (let j = start + 1; j < lines.length; j++) {
      if (isTableHeader(lines[j]!)) {
        end = j
        break
      }
    }
    const replacement = [...bodyLines]
    lines.splice(start + 1, end - (start + 1), ...replacement)
    return joinLines(lines, eol)
  }

  // Append new table at EOF with a leading blank separator.
  const block = ['', header, ...bodyLines]
  if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') {
    lines.push(...block)
  } else {
    lines.push(header, ...bodyLines)
  }
  return joinLines(lines, eol)
}

/** Strip surrounding TOML quotes/whitespace from a raw value token. */
function normalizeValue(raw: string): string {
  const trimmed = raw.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Read a root-level key value (normalized), or undefined if missing/not in root. */
export function readTopLevelKey(content: string, key: string): string | undefined {
  const eol = detectEol(content)
  const lines = splitLines(content, eol)
  const firstTable = findFirstTableLine(lines)
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`)
  for (let i = 0; i < firstTable; i++) {
    const m = lines[i]!.match(re)
    if (m) return normalizeValue(m[1]!)
  }
  return undefined
}

/** Read a field value from [model_providers.<id>] (normalized), or undefined. */
export function readProviderTableField(
  content: string,
  providerId: string,
  field: string,
): string | undefined {
  const eol = detectEol(content)
  const lines = splitLines(content, eol)
  const header = providerHeaderLine(providerId)
  let inTable = false
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`)
  for (const line of lines) {
    if (isTableHeader(line)) {
      inTable = isProviderHeader(line, header)
      continue
    }
    if (inTable) {
      const m = line.match(re)
      if (m) return normalizeValue(m[1]!)
    }
  }
  return undefined
}
```

> **实现后加固（code-review）**：`isProviderHeader` 改用正则匹配表名（允许尾随注释/空白），避免表头带注释时追加重复表；`readTopLevelKey`/`readProviderTableField` 的值捕获正则改为排除行内注释；`formatTomlString` 增加控制字符转义；`splitLines` 改用通用换行 split 处理混合 EOL。见 commit `b5811b1`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/cli/toml-editor.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/cli/toml-editor.ts test/cli/toml-editor.test.ts
git commit -m "feat(cli): add toml-editor pure functions for codex config editing"
```

---

### Task 2: codex-home.ts — codex 路径解析

**Files:**
- Create: `src/cli/codex-home.ts`
- Test: `test/cli/codex-home.test.ts`

**Interfaces:**
- Consumes: `node:os` 的 `homedir`, `node:path` 的 `join`
- Produces: `resolveCodexHome`, `resolveCodexConfigPath`, `resolveCodexCatalogPath`, `DEFAULT_CATALOG_FILENAME`（供 Task 4 使用）

- [ ] **Step 1: 写失败测试 `test/cli/codex-home.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/Users/test'),
}))

import { homedir } from 'node:os'
import { resolveCodexHome, resolveCodexConfigPath, resolveCodexCatalogPath } from '../../src/cli/codex-home.js'

const mockedHomedir = vi.mocked(homedir)

beforeEach(() => {
  vi.unstubAllEnvs()
  mockedHomedir.mockReturnValue('/Users/test')
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveCodexHome', () => {
  it('uses CODEX_HOME when set', () => {
    vi.stubEnv('CODEX_HOME', '/custom/codex')
    expect(resolveCodexHome()).toBe('/custom/codex')
  })
  it('falls back to homedir/.codex when CODEX_HOME empty', () => {
    vi.stubEnv('CODEX_HOME', '')
    mockedHomedir.mockReturnValue('/Users/test')
    expect(resolveCodexHome()).toBe('/Users/test/.codex')
  })
  it('falls back when CODEX_HOME unset', () => {
    delete process.env.CODEX_HOME
    mockedHomedir.mockReturnValue('/Users/test')
    expect(resolveCodexHome()).toBe('/Users/test/.codex')
  })
})

describe('resolveCodexConfigPath', () => {
  it('joins config.toml', () => {
    expect(resolveCodexConfigPath('/c/h')).toBe('/c/h/config.toml')
  })
})

describe('resolveCodexCatalogPath', () => {
  it('joins default catalog filename', () => {
    expect(resolveCodexCatalogPath('/c/h')).toBe('/c/h/llm-proxy-model-catalog.json')
  })
  it('accepts custom filename', () => {
    expect(resolveCodexCatalogPath('/c/h', 'other.json')).toBe('/c/h/other.json')
  })
})
```

> **实现后加固（code-review）**："falls back when CODEX_HOME unset" 测试改用 save/delete/try-finally 恢复，避免 `delete process.env` 泄漏。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/cli/codex-home.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/cli/codex-home.ts`**

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CATALOG_FILENAME = 'llm-proxy-model-catalog.json'

/** Resolve $CODEX_HOME (default ~/.codex). Empty env value falls back to default. */
export function resolveCodexHome(): string {
  const env = process.env.CODEX_HOME
  if (env && env.trim() !== '') return env
  return join(homedir(), '.codex')
}

/** Path to ~/.codex/config.toml. */
export function resolveCodexConfigPath(codexHome: string = resolveCodexHome()): string {
  return join(codexHome, 'config.toml')
}

/** Path to the model catalog JSON file inside codex home. */
export function resolveCodexCatalogPath(
  codexHome: string = resolveCodexHome(),
  filename: string = DEFAULT_CATALOG_FILENAME,
): string {
  return join(codexHome, filename)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/cli/codex-home.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli/codex-home.ts test/cli/codex-home.test.ts
git commit -m "feat(cli): add codex home path resolution helpers"
```

---

### Task 3: codex-toml.ts — config.toml 编辑编排

**Files:**
- Create: `src/cli/codex-toml.ts`
- Test: `test/cli/codex-toml.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `setTopLevelKey`, `setProviderTable`, `readTopLevelKey`, `readProviderTableField`, `formatTomlString`
- Produces: `applyCodexConfigEdits`, `CodexConfigEdits`, `TomlOverwriteReport`（供 Task 4 使用）

- [ ] **Step 1: 写失败测试 `test/cli/codex-toml.test.ts`**

```typescript
import { describe, it, expect } from 'vitest'
import { applyCodexConfigEdits } from '../../src/cli/codex-toml.js'

const edits = {
  catalogFilename: 'llm-proxy-model-catalog.json',
  providerId: 'llm-proxy',
  providerName: 'LLM Proxy',
  baseUrl: 'http://127.0.0.1:8056/codex/v1',
  wireApi: 'responses' as const,
  modelSlug: 'zhipu/glm-5.2',
}

describe('applyCodexConfigEdits', () => {
  it('applies all 4 edits to an empty config with no overwrite reports', () => {
    const { content, overwritten } = applyCodexConfigEdits('', edits)
    expect(content).toContain('model_catalog_json = "llm-proxy-model-catalog.json"')
    expect(content).toContain('model_provider = "llm-proxy"')
    expect(content).toContain('model = "zhipu/glm-5.2"')
    expect(content).toContain('[model_providers.llm-proxy]')
    expect(content).toContain('base_url = "http://127.0.0.1:8056/codex/v1"')
    expect(content).toContain('wire_api = "responses"')
    expect(overwritten).toEqual([])
  })

  it('reports overwrite when model already set to a different value', () => {
    const content = 'model = "gpt-5"\n'
    const { content: out, overwritten } = applyCodexConfigEdits(content, edits)
    expect(out).toContain('model = "zhipu/glm-5.2"')
    expect(overwritten.some((r) => r.key === 'model' && r.oldValue === 'gpt-5')).toBe(true)
  })

  it('reports overwrite when provider table already exists', () => {
    const content = '[model_providers.llm-proxy]\nname = "old"\nenv_key = "X"\n'
    const { overwritten } = applyCodexConfigEdits(content, edits)
    expect(overwritten.some((r) => r.kind === 'provider-table' && r.key === 'llm-proxy')).toBe(true)
  })

  it('is idempotent: second run yields same content and no overwrites', () => {
    const first = applyCodexConfigEdits('', edits)
    const second = applyCodexConfigEdits(first.content, edits)
    expect(second.content).toBe(first.content)
    expect(second.overwritten).toEqual([])
  })

  it('preserves existing comments and other providers', () => {
    const content = '# my codex config\nmodel = "gpt-5"\n\n[model_providers.openai]\nname = "OpenAI"\n'
    const { content: out } = applyCodexConfigEdits(content, edits)
    expect(out).toContain('# my codex config')
    expect(out).toContain('[model_providers.openai]\nname = "OpenAI"')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/cli/codex-toml.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/cli/codex-toml.ts`**

```typescript
import {
  setTopLevelKey,
  setProviderTable,
  readTopLevelKey,
  readProviderTableField,
  formatTomlString,
} from './toml-editor.js'

export interface CodexConfigEdits {
  catalogFilename: string
  providerId: string
  providerName: string
  baseUrl: string
  wireApi: 'responses'
  modelSlug: string
}

export interface TomlOverwriteReport {
  kind: 'top-level-key' | 'provider-table'
  key: string
  oldValue: string
  newValue: string
}

/** Apply the 4 codex config edits, reporting any values overwritten. */
export function applyCodexConfigEdits(
  content: string,
  params: CodexConfigEdits,
): { content: string; overwritten: TomlOverwriteReport[] } {
  const overwritten: TomlOverwriteReport[] = []
  let cur = content

  const topKeys: Array<{ key: string; newValue: string }> = [
    { key: 'model_catalog_json', newValue: formatTomlString(params.catalogFilename) },
    { key: 'model_provider', newValue: formatTomlString(params.providerId) },
    { key: 'model', newValue: formatTomlString(params.modelSlug) },
  ]

  for (const { key, newValue } of topKeys) {
    const oldRaw = readTopLevelKey(cur, key)
    if (oldRaw !== undefined && oldRaw !== normalizeTomlString(newValue)) {
      overwritten.push({ kind: 'top-level-key', key, oldValue: oldRaw, newValue: normalizeTomlString(newValue) })
    }
    cur = setTopLevelKey(cur, key, newValue)
  }

  // Provider table.
  const fields: Record<string, string | boolean> = {
    name: params.providerName,
    base_url: params.baseUrl,
    wire_api: params.wireApi,
  }
  const oldName = readProviderTableField(cur, params.providerId, 'name')
  const oldBaseUrl = readProviderTableField(cur, params.providerId, 'base_url')
  const oldWireApi = readProviderTableField(cur, params.providerId, 'wire_api')
  if (
    oldName !== undefined ||
    oldBaseUrl !== undefined ||
    oldWireApi !== undefined
  ) {
    const changed =
      (oldName !== undefined && oldName !== params.providerName) ||
      (oldBaseUrl !== undefined && oldBaseUrl !== params.baseUrl) ||
      (oldWireApi !== undefined && oldWireApi !== params.wireApi)
    if (changed || oldName === undefined || oldBaseUrl === undefined || oldWireApi === undefined) {
      overwritten.push({
        kind: 'provider-table',
        key: params.providerId,
        oldValue: '<existing table>',
        newValue: '<replaced>',
      })
    }
  }
  cur = setProviderTable(cur, params.providerId, fields)

  return { content: cur, overwritten }
}

/** Normalize a formatted TOML string literal back to its raw value for comparison. */
function normalizeTomlString(formatted: string): string {
  const trimmed = formatted.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
```

> **实现后加固（code-review）**：`normalizeTomlString` 改为只剥外层引号（与 `normalizeValue` 对称，不反转义），修复含转义字符的旧值导致的幂等性误报。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/cli/codex-toml.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/cli/codex-toml.ts test/cli/codex-toml.test.ts
git commit -m "feat(cli): add applyCodexConfigEdits orchestration for codex install"
```

---

### Task 4: codex-install.ts + codex.ts + cli.ts — install 命令与注册

**Files:**
- Create: `src/cli/codex-install.ts`
- Create: `src/cli/codex.ts`
- Modify: `src/cli/cli.ts`
- Test: `test/cli/codex-install.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `resolveCodexHome`/`resolveCodexConfigPath`/`resolveCodexCatalogPath`/`DEFAULT_CATALOG_FILENAME`；Task 3 的 `applyCodexConfigEdits`/`CodexConfigEdits`；`codex-types.ts` 的 `codexModelInfoSchema`/`CodexModelInfo`；`config.ts` 的 `Settings`/`loadSettingsFromFile`；`context.ts` 的 `resolveCliContext`
- Produces: `codex install` CLI 命令

- [ ] **Step 1: 写失败测试 `test/cli/codex-install.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTempDir, writeTempSettings } from '../helpers/temp-file.js'
import { makeSettings } from '../helpers/settings.js'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCodexBaseUrl, fetchCodexModelsResponse, runCodexInstall } from '../../src/cli/codex-install.js'

function makeModel(slug: string, displayName = slug) {
  return {
    slug,
    display_name: displayName,
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
}

describe('buildCodexBaseUrl', () => {
  it('builds http url without trailing slash', () => {
    const settings = makeSettings({}, { service: { name: 'llm-proxy', host: '127.0.0.1', port: 8056 } })
    expect(buildCodexBaseUrl(settings)).toBe('http://127.0.0.1:8056/codex/v1')
  })
  it('brackets IPv6 host', () => {
    const settings = makeSettings({}, { service: { name: 'llm-proxy', host: '::1', port: 8056 } })
    expect(buildCodexBaseUrl(settings)).toBe('http://[::1]:8056/codex/v1')
  })
})

describe('fetchCodexModelsResponse', () => {
  it('parses a 200 models response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const res = await fetchCodexModelsResponse({ url: 'http://x/codex/v1/models', fetchImpl })
    expect(res.models).toHaveLength(2)
  })
  it('throws http503 on 503', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { type: 'server_error', message: 'codex CLI missing' } }),
    }) as unknown as typeof fetch
    await expect(fetchCodexModelsResponse({ url: 'http://x/codex/v1/models', fetchImpl })).rejects.toMatchObject({
      kind: 'http503',
    })
  })
  it('throws network on TypeError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch
    await expect(fetchCodexModelsResponse({ url: 'http://x/codex/v1/models', fetchImpl })).rejects.toMatchObject({
      kind: 'network',
    })
  })
})

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
    const fs = { readFile, writeFile: vi.fn(), mkdir, access: async () => { throw new Error('enoent') } }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModel: async () => 'a' },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('aborts on fetch network error', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs: { readFile, writeFile: writeFileSpy, mkdir, access: async () => {} },
      codexHome: tmp.dir,
      prompts: { selectModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('succeeds: writes catalog + edits config.toml', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), '# codex\nmodel = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('zhipu/glm-5.2', 'GLM-5.2')] }),
    }) as unknown as typeof fetch
    let writtenConfig = ''
    let writtenCatalog = ''
    const fs = {
      readFile: async (p: string) => readFile(p, 'utf8'),
      writeFile: async (p: string, d: string) => {
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir,
      access: async () => {},
    }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModel: async () => 'zhipu/glm-5.2' },
    })
    expect(writtenCatalog).toContain('"models"')
    expect(writtenCatalog).toContain('zhipu/glm-5.2')
    expect(writtenConfig).toContain('model_catalog_json = "llm-proxy-model-catalog.json"')
    expect(writtenConfig).toContain('model_provider = "llm-proxy"')
    expect(writtenConfig).toContain('model = "zhipu/glm-5.2"')
    expect(writtenConfig).toContain('[model_providers.llm-proxy]')
    expect(writtenConfig).toContain('# codex') // comment preserved
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs: { readFile, writeFile: writeFileSpy, mkdir, access: async () => {} },
      codexHome: tmp.dir,
      prompts: { selectModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts on cancel (selectModel returns null): catalog written, config untouched', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('zhipu/glm-5.2')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs: { readFile, writeFile: writeFileSpy, mkdir, access: async () => {} },
      codexHome: tmp.dir,
      prompts: { selectModel: async () => null },
    })
    // catalog (.json) written once; config.toml never written
    expect(writeFileSpy).toHaveBeenCalledTimes(1)
    expect(writeFileSpy.mock.calls[0]![0]).toMatch(/\.json$/)
  })
})
```

> **注**：`makeSettings` 来自 `test/helpers/settings.ts`（构造完整 `Settings`，避免 `as unknown` 违反 `ts-development.md`）。`runCodexInstall` 测试用 `writeTempSettings` 写 settings.jsonc 再 `loadSettingsFromFile` 解析——该 settings 内容通过 `settingsSchema` 校验。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/cli/codex-install.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/cli/codex-install.ts`**

```typescript
import { Command } from 'commander'
import * as clack from '@clack/prompts'
import { z } from 'zod/v3'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { codexModelInfoSchema } from '../codex-types.js'
import type { CodexModelInfo } from '../codex-types.js'
import { loadSettingsFromFile } from '../config.js'
import type { Settings } from '../config.js'
import { resolveCliContext } from './context.js'
import { resolveCodexHome, resolveCodexConfigPath, resolveCodexCatalogPath, DEFAULT_CATALOG_FILENAME } from './codex-home.js'
import { applyCodexConfigEdits } from './codex-toml.js'

const codexModelsResponseSchema = z.object({ models: z.array(codexModelInfoSchema) })

export type CodexEndpointErrorKind = 'network' | 'http503' | 'http' | 'parse'

export class CodexEndpointError extends Error {
  constructor(
    public kind: CodexEndpointErrorKind,
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message)
    this.name = 'CodexEndpointError'
  }
}

/** Build the codex base URL from service settings (no trailing slash; IPv6 bracketed). */
export function buildCodexBaseUrl(settings: Settings): string {
  const { host, port } = settings.service
  const bracketed = host.includes(':') ? `[${host}]` : host
  return `http://${bracketed}:${port}/codex/v1`
}

/** Fetch and validate the /codex/v1/models response. Throws typed CodexEndpointError. */
export async function fetchCodexModelsResponse(args: {
  url: string
  fetchImpl?: typeof fetch
}): Promise<{ models: CodexModelInfo[] }> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch
  let res: Response
  try {
    res = await fetchImpl(args.url)
  } catch (err) {
    throw new CodexEndpointError('network', err instanceof Error ? err.message : String(err))
  }
  if (res.status === 503) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error?: { message?: string } }).error?.message ?? 'unknown')
        : 'unknown'
    throw new CodexEndpointError('http503', message, 503, body)
  }
  if (!res.ok) {
    await res.text().catch(() => {}) // consume body to avoid connection leak
    throw new CodexEndpointError('http', `HTTP ${res.status}`, res.status)
  }
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new CodexEndpointError('parse', err instanceof Error ? err.message : String(err))
  }
  const parsed = codexModelsResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new CodexEndpointError('parse', parsed.error.message)
  }
  return { models: parsed.data.models }
}

/** Injectable fs surface for runCodexInstall (avoids `unknown`). */
export interface CodexInstallFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>
  access(path: string): Promise<void>
}

export interface CodexInstallPrompts {
  selectModel(models: CodexModelInfo[]): Promise<string | null>
}

export interface CodexInstallOptions {
  settingsPath: string
  fetchImpl?: typeof fetch
  fs?: CodexInstallFs
  codexHome?: string
  prompts?: CodexInstallPrompts
}

const defaultFs: CodexInstallFs = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, d) => writeFile(p, d, 'utf8'),
  mkdir: (p, o) => mkdir(p, o).then(() => undefined),
  access: (p) => access(p),
}

function defaultPrompts(): CodexInstallPrompts {
  return {
    async selectModel(models) {
      const selected = await clack.select({
        message: 'Select default model',
        options: models.map((m) => ({ value: m.slug, label: m.display_name, hint: m.slug })),
        initialValue: models[0]!.slug,
      })
      if (clack.isCancel(selected)) return null
      return selected as string
    },
  }
}

/** Run the codex install flow. Pure-ish: all I/O injectable. */
export async function runCodexInstall(options: CodexInstallOptions): Promise<void> {
  const fs = options.fs ?? defaultFs
  const prompts = options.prompts ?? defaultPrompts()
  clack.intro('llm-proxy codex install')

  // 1. Load settings.
  let settings: Settings
  try {
    settings = await loadSettingsFromFile(options.settingsPath)
  } catch (err) {
    clack.log.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }

  const codexHome = options.codexHome ?? resolveCodexHome()
  const configPath = resolveCodexConfigPath(codexHome)
  const catalogPath = resolveCodexCatalogPath(codexHome)

  // 2. config.toml must exist (never create it).
  try {
    await fs.access(configPath)
  } catch {
    clack.log.error(`Codex config not found at ${configPath}. Run codex once first to create it.`)
    clack.outro('Aborted')
    return
  }

  // 3. Fetch catalog.
  const baseUrl = buildCodexBaseUrl(settings)
  clack.log.step(`Fetching model catalog from ${baseUrl}...`)
  let modelsRes: { models: CodexModelInfo[] }
  try {
    modelsRes = await fetchCodexModelsResponse({ url: `${baseUrl}/models`, fetchImpl: options.fetchImpl })
  } catch (err) {
    if (err instanceof CodexEndpointError) {
      clack.log.error(mapEndpointError(err))
    } else {
      clack.log.error(`Failed to fetch catalog: ${err instanceof Error ? err.message : String(err)}`)
    }
    clack.outro('Aborted')
    return
  }

  // 4. Non-empty catalog.
  if (modelsRes.models.length === 0) {
    clack.log.error('Proxy returned an empty model catalog. Configure at least one provider/model in settings.jsonc.')
    clack.outro('Aborted')
    return
  }

  // 5. Write catalog file.
  try {
    await fs.mkdir(codexHome, { recursive: true })
    await fs.writeFile(catalogPath, JSON.stringify(modelsRes, null, 2))
  } catch (err) {
    clack.log.error(`Failed to write catalog: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }
  clack.log.step(`Wrote catalog → ${catalogPath}`)

  // 6. Select default model.
  let slug: string | null
  try {
    slug = await prompts.selectModel(modelsRes.models)
  } catch (err) {
    clack.log.error(`Model selection failed: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }
  if (slug === null) {
    clack.cancel('Operation cancelled')
    return
  }
  // Validate slug is in the catalog (guards injected/custom prompts).
  if (!modelsRes.models.some((m) => m.slug === slug)) {
    clack.log.error(`Selected model "${slug}" is not in the catalog`)
    clack.outro('Aborted')
    return
  }

  // 7. Edit config.toml.
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
    modelSlug: slug,
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
}

function mapEndpointError(err: CodexEndpointError): string {
  switch (err.kind) {
    case 'network':
      return `Could not connect to the proxy at the configured address. Is it running? Start it with: pnpm dev serve`
    case 'http503':
      return `Proxy could not build the codex catalog (${err.message}). Is codex CLI installed and on PATH on the host?`
    case 'http':
      return `Unexpected response from /codex/v1/models: ${err.status}`
    case 'parse':
      return `Malformed response from proxy: ${err.message}`
  }
}

export function createCodexInstallCommand(): Command {
  return new Command('install')
    .description('Install llm-proxy as a codex model provider in ~/.codex/config.toml')
    .action(async () => {
      const { settingsPath } = resolveCliContext()
      await runCodexInstall({ settingsPath })
    })
}
```

> **实现后加固（code-review）**：`defaultFs` 改静态 import（非动态 import 每次）；非 503 `!res.ok` 分支消费 `res.text()` 避免连接泄漏；`catalogFilename` 复用 `DEFAULT_CATALOG_FILENAME` 常量（单一来源）；删未用的 `CodexModelsResponse` 类型；selectModel 后校验 slug ∈ catalog。

- [ ] **Step 4: 实现 `src/cli/codex.ts`**

```typescript
import { Command } from 'commander'
import { createCodexInstallCommand } from './codex-install.js'

export function createCodexCommand(): Command {
  return new Command('codex').description('Codex integration commands').addCommand(createCodexInstallCommand())
}
```

- [ ] **Step 5: 修改 `src/cli/cli.ts` 注册命令**

在现有 import 后加 `import { createCodexCommand } from './codex.js'`，在 `.addCommand(createModelsCommand())` 后加 `.addCommand(createCodexCommand())`。不改动其他行。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test test/cli/codex-install.test.ts`
Expected: PASS

- [ ] **Step 7: 运行 typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 通过，全量测试无回归

- [ ] **Step 8: 提交**

```bash
git add src/cli/codex-install.ts src/cli/codex.ts src/cli/cli.ts test/cli/codex-install.test.ts
git commit -m "feat(cli): add codex install command"
```
