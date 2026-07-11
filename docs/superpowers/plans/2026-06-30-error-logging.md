# 错误日志功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当上游 provider 请求异常时，将客户端完整入参与上游完整出参记录到独立错误日志文件（NDJSON），便于定位修复。

**Architecture:** 在 `handleProtocolRequest` 集中拦截。流式路径用 `teeStream` 包装器缓冲 chunk 引用，出错时连同入参交给 `ErrorLogger` 落盘；非流式路径在 `handleUpstreamError` 直接落盘。`ErrorLogger` 通过 `AppDependencies` 注入，复用 `logging.ts` 的 `redact()` 脱敏与 `LOG_DIR`，独立错误日志文件 30 天轮转。

**Tech Stack:** TypeScript (ESM/NodeNext), Hono, Zod, Vitest, pino

---

## 文件结构

**新增：**

- `src/server/error-logger.ts` — `ErrorLogger` 类：截断、脱敏、序列化、追加写入 NDJSON；导出 `ErrorLogEntry` 类型与 `ERROR_LOG_RETENTION_DAYS` 常量
- `src/server/tee-stream.ts` — `teeStream` async generator：yield chunk 同时 push 引用到 buffer
- `test/server/error-logger.test.ts` — ErrorLogger 单元测试（截断、脱敏、轮转、enabled 开关）
- `test/server/tee-stream.test.ts` — teeStream 单元测试（缓冲、传播异常、正常丢弃）
- `test/server/error-logging-integration.test.ts` — 端到端集成测试（四类异常场景）

**修改：**

- `src/config.ts` — 新增 `errorLoggingSchema`，挂到 `settingsSchema`；导出 `ErrorLoggingConfig` 类型
- `src/server/logging.ts` — `cleanOldLogs` 扩展支持 `errors-*.ndjson` 30 天轮转
- `src/server/types.ts` — `AppDependencies` 新增 `errorLogger?` 字段
- `src/server/handle-protocol.ts` — 流式路径接入 `teeStream` 与 `onError` 落盘；`handleUpstreamError` 接入 `ErrorLogger.log()`
- `src/server/app.ts` — `createApp` 创建 `ErrorLogger` 单例注入 `protocolCtx`/`handleProtocolRequest`
- `test/helpers/settings.ts` — `baseSettings` 补充 `errorLogging` 默认值
- `config/settings.schema.json` — `pnpm generate:schema` 重新生成

---

### Task 1: 配置 schema — errorLogging

**Files:**

- Modify: `src/config.ts:178-200`（`settingsSchema` 定义处）
- Test: `test/server/error-logger.test.ts`（后续 Task 创建，本 Task 仅验证 schema）

- [ ] **Step 1: 写 schema 失败测试**

创建 `test/server/error-logger.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { settingsSchema } from '../../src/config.js'

describe('errorLogging config', () => {
  it('applies defaults when errorLogging omitted', () => {
    const parsed = settingsSchema.parse({ providers: {} })
    expect(parsed.errorLogging).toEqual({
      enabled: true,
      maxBodyLength: 262144,
    })
  })

  it('respects explicit errorLogging values', () => {
    const parsed = settingsSchema.parse({
      providers: {},
      errorLogging: { enabled: false, maxBodyLength: 1024 },
    })
    expect(parsed.errorLogging).toEqual({ enabled: false, maxBodyLength: 1024 })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/server/error-logger.test.ts`
Expected: FAIL — `parsed.errorLogging` 为 `undefined`

- [ ] **Step 3: 实现 schema**

在 `src/config.ts` 的 `settingsSchema` 定义之前（约第 178 行 `providerConfigSchema` 之后）添加：

```ts
export const errorLoggingSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxBodyLength: z.number().int().positive().default(262144),
  })
  .default({})

export type ErrorLoggingConfig = z.infer<typeof errorLoggingSchema>
```

在 `settingsSchema`（约第 180 行）的 `codex: codexSettingsSchema.default({}),` 之后、`providers` 之前添加：

```ts
  errorLogging: errorLoggingSchema.default({}),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/server/error-logger.test.ts`
Expected: PASS

- [ ] **Step 5: 更新 test helper 并提交**

修改 `test/helpers/settings.ts`，在 `baseSettings` 的 `codex: { ... }` 之后、`providers: {}` 之前添加：

```ts
  errorLogging: { enabled: true, maxBodyLength: 262144 },
```

运行 `pnpm typecheck` 确认无类型错误（`baseSettings` 缺字段会被 `exactOptionalPropertyTypes` 报错）。

Run: `pnpm typecheck`
Expected: 无错误

```bash
git add src/config.ts test/helpers/settings.ts test/server/error-logger.test.ts
git commit -m "feat(config): add errorLogging settings schema"
```

---

### Task 2: teeStream 包装器

**Files:**

- Create: `src/server/tee-stream.ts`
- Test: `test/server/tee-stream.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/server/tee-stream.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { teeStream } from '../../src/server/tee-stream.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'

async function* fromArray(parts: ProxyStreamPart[]): AsyncIterable<ProxyStreamPart> {
  for (const part of parts) yield part
}

describe('teeStream', () => {
  it('buffers all yielded chunks into the buffer array', async () => {
    const chunks: ProxyStreamPart[] = [
      { type: 'text-delta', text: 'hello' },
      { type: 'text-delta', text: ' world' },
      { type: 'finish', finishReason: 'stop', usage: null, response: undefined },
    ]
    const buffer: ProxyStreamPart[] = []
    const collected: ProxyStreamPart[] = []
    for await (const part of teeStream(fromArray(chunks), buffer)) {
      collected.push(part)
    }
    expect(collected).toEqual(chunks)
    expect(buffer).toEqual(chunks)
  })

  it('buffers partial chunks when source throws mid-stream', async () => {
    const emitted: ProxyStreamPart[] = [{ type: 'text-delta', text: 'partial' }]
    async function* throwingStream(): AsyncIterable<ProxyStreamPart> {
      yield emitted[0]!
      throw new Error('upstream broke')
    }
    const buffer: ProxyStreamPart[] = []
    await expect(async () => {
      for await (const _ of teeStream(throwingStream(), buffer)) {
        // consume
      }
    }).rejects.toThrow('upstream broke')
    expect(buffer).toEqual(emitted)
  })

  it('preserves object identity (stores references not clones)', async () => {
    const chunk: ProxyStreamPart = { type: 'text-delta', text: 'x' }
    const buffer: ProxyStreamPart[] = []
    for await (const part of teeStream(fromArray([chunk]), buffer)) {
      expect(part).toBe(chunk)
    }
    expect(buffer[0]).toBe(chunk)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/server/tee-stream.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 teeStream**

创建 `src/server/tee-stream.ts`：

```ts
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'

/**
 * 包装异步流，在 yield 每个 chunk 的同时将其引用 push 到 buffer。
 * 不做序列化，不捕获异常——异常正常向上传播。
 * 用于错误日志：出错时 buffer 含已接收的全部 chunks，正常结束时由调用方丢弃。
 */
export async function* teeStream(
  source: AsyncIterable<ProxyStreamPart>,
  buffer: ProxyStreamPart[],
): AsyncIterable<ProxyStreamPart> {
  for await (const part of source) {
    buffer.push(part)
    yield part
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/server/tee-stream.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/tee-stream.ts test/server/tee-stream.test.ts
git commit -m "feat(server): add teeStream chunk buffer wrapper"
```

---

### Task 3: ErrorLogger 模块 — 截断、脱敏、落盘

**Files:**

- Create: `src/server/error-logger.ts`
- Test: `test/server/error-logger.test.ts`（追加到 Task 1 创建的文件）

- [ ] **Step 1: 写失败测试**

在 `test/server/error-logger.test.ts` 顶部追加 import，并新增 describe 块：

```ts
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { settingsSchema } from '../../src/config.js'
import { ErrorLogger, type ErrorLogEntry } from '../../src/server/error-logger.js'

let tmpLogDir: string
beforeAll(() => {
  tmpLogDir = mkdtempSync(join(tmpdir(), 'errlog-'))
})
afterAll(() => {
  rmSync(tmpLogDir, { recursive: true, force: true })
})

function readErrorLog(logDir: string): ErrorLogEntry[] {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const path = join(logDir, `errors-${y}-${m}-${d}.ndjson`)
  const raw = readFileSync(path, 'utf8').trim()
  if (raw === '') return []
  return raw.split('\n').map((line) => JSON.parse(line) as ErrorLogEntry)
}

// ... 保留 Task 1 的 errorLogging config describe 块 ...

describe('ErrorLogger', () => {
  const baseEntry: ErrorLogEntry = {
    timestamp: '',
    requestId: 'req-1',
    phase: 'generate',
    provider: 'test-provider',
    requestedModel: 'test-model',
    actualModel: 'upstream-model',
    error: { name: 'Error', message: 'boom', stack: 'Error: boom\n  at test' },
    request: { model: 'test-model', messages: [] },
    response: null,
  }

  it('writes a valid NDJSON line with CN timestamp', () => {
    const logger = new ErrorLogger({ logDir: tmpLogDir, enabled: true, maxBodyLength: 262144 })
    logger.log({ ...baseEntry })
    const records = readErrorLog(tmpLogDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.requestId).toBe('req-1')
    // YYYY-MM-DD HH:MM:SS 格式
    expect(records[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('redacts authorization field in request', () => {
    const logger = new ErrorLogger({ logDir: tmpLogDir, enabled: true, maxBodyLength: 262144 })
    logger.log({
      ...baseEntry,
      requestId: 'req-redact',
      request: { authorization: 'Bearer secret-key', model: 'x' },
    })
    const records = readErrorLog(tmpLogDir)
    const target = records.find((r) => r.requestId === 'req-redact')!
    expect((target.request as Record<string, unknown>).authorization).toBe('[REDACTED]')
  })

  it('truncates oversized request body', () => {
    const logger = new ErrorLogger({ logDir: tmpLogDir, enabled: true, maxBodyLength: 100 })
    const bigText = 'x'.repeat(500)
    logger.log({
      ...baseEntry,
      requestId: 'req-trunc',
      request: { big: bigText },
    })
    const records = readErrorLog(tmpLogDir)
    const target = records.find((r) => r.requestId === 'req-trunc')!
    const req = target.request as Record<string, unknown>
    expect(req._truncated).toBe(true)
    expect(typeof req.originalLength).toBe('number')
    expect(typeof req.preview).toBe('string')
    expect((req.preview as string).length).toBeLessThanOrEqual(1024)
  })

  it('does nothing when enabled is false', () => {
    const logger = new ErrorLogger({ logDir: tmpLogDir, enabled: false, maxBodyLength: 262144 })
    logger.log({ ...baseEntry, requestId: 'req-skip' })
    const records = readErrorLog(tmpLogDir)
    expect(records.find((r) => r.requestId === 'req-skip')).toBeUndefined()
  })

  it('does not throw when file write fails (logs fallback)', () => {
    const logger = new ErrorLogger({
      logDir: '/nonexistent/path/that/cannot/be/created',
      enabled: true,
      maxBodyLength: 262144,
    })
    // 不应抛出
    expect(() => logger.log({ ...baseEntry, requestId: 'req-fallback' })).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/server/error-logger.test.ts`
Expected: FAIL — `ErrorLogger` 模块不存在

- [ ] **Step 3: 实现 ErrorLogger**

创建 `src/server/error-logger.ts`：

```ts
import { createWriteStream, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import { redact, logger as fallbackLogger } from './logging.js'

export const ERROR_LOG_RETENTION_DAYS = 30

/** 错误日志记录的 phase，复用 handle-protocol 的 ErrorPhase */
export type ErrorLogPhase = 'stream' | 'stream-only' | 'generate'

export interface ErrorLogEntry {
  timestamp: string
  requestId: string
  phase: ErrorLogPhase
  provider: string
  requestedModel: string
  actualModel: string
  error: { name: string; message: string; stack?: string }
  request: unknown
  response: ProxyStreamPart[] | null
}

export interface ErrorLoggerOptions {
  logDir: string
  enabled: boolean
  maxBodyLength: number
}

const PREVIEW_LENGTH = 1024

/** 中国时区（+08:00）格式化为 YYYY-MM-DD HH:MM:SS，不标注时区 */
function formatCNTimestamp(date: Date = new Date()): string {
  const cn = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const y = cn.getUTCFullYear()
  const m = String(cn.getUTCMonth() + 1).padStart(2, '0')
  const d = String(cn.getUTCDate()).padStart(2, '0')
  const h = String(cn.getUTCHours()).padStart(2, '0')
  const min = String(cn.getUTCMinutes()).padStart(2, '0')
  const s = String(cn.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}:${s}`
}

function getErrorLogFileName(date: Date = new Date()): string {
  const cn = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const y = cn.getUTCFullYear()
  const m = String(cn.getUTCMonth() + 1).padStart(2, '0')
  const d = String(cn.getUTCDate()).padStart(2, '0')
  return `errors-${y}-${m}-${d}.ndjson`
}

/** 截断超大 body：序列化后超限则替换为 { _truncated, originalLength, preview } */
function truncateBody(value: unknown, maxBodyLength: number): unknown {
  const redacted = redact(value)
  const serialized = JSON.stringify(redacted)
  if (serialized.length <= maxBodyLength) {
    return redacted
  }
  return {
    _truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, PREVIEW_LENGTH),
  }
}

/**
 * 错误日志落盘器。createApp 作用域单例。
 * 接收结构化数据，截断 → 脱敏 → 序列化 → 追加写入 NDJSON 文件。
 * 文件写入失败时回退到普通 logger 记 error，不抛出。
 */
export class ErrorLogger {
  private readonly logDir: string
  private readonly enabled: boolean
  private readonly maxBodyLength: number

  constructor(opts: ErrorLoggerOptions) {
    this.logDir = opts.logDir
    this.enabled = opts.enabled
    this.maxBodyLength = opts.maxBodyLength
  }

  log(entry: Omit<ErrorLogEntry, 'timestamp'>): void {
    if (!this.enabled) return
    try {
      const record: ErrorLogEntry = {
        ...entry,
        timestamp: formatCNTimestamp(),
        request: truncateBody(entry.request, this.maxBodyLength),
        response: entry.response === null ? null : truncateBody(entry.response, this.maxBodyLength),
      }
      const line = JSON.stringify(record)
      mkdirSync(resolve(this.logDir), { recursive: true })
      const filePath = resolve(this.logDir, getErrorLogFileName())
      const stream = createWriteStream(filePath, { flags: 'a' })
      stream.write(`${line}\n`)
      stream.end()
    } catch (err) {
      fallbackLogger.error({ err }, 'error log write failed')
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/server/error-logger.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/error-logger.ts test/server/error-logger.test.ts
git commit -m "feat(server): add ErrorLogger with truncation, redaction, NDJSON output"
```

---

### Task 4: cleanOldLogs 轮转扩展 — errors 文件 30 天

**Files:**

- Modify: `src/server/logging.ts:155-172`（`cleanOldLogs` 函数）
- Test: `test/server/error-logger.test.ts`（追加轮转测试）

- [ ] **Step 1: 写失败测试**

在 `test/server/error-logger.test.ts` 追加：

```ts
import { cleanOldLogs } from '../../src/server/logging.js'
import { utimesSync, existsSync } from 'node:fs'

describe('cleanOldLogs error file rotation', () => {
  it('deletes error log files older than 30 days but keeps recent ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rotation-'))
    const now = Date.now()
    const oldMs = now - 31 * 24 * 60 * 60 * 1000
    const recentMs = now - 5 * 24 * 60 * 60 * 1000

    const oldFile = join(dir, 'errors-2025-05-01.ndjson')
    writeFileSync(oldFile, '{"test":1}')
    const recentFile = join(dir, 'errors-2026-06-25.ndjson')
    writeFileSync(recentFile, '{"test":2}')

    utimesSync(oldFile, oldMs / 1000, oldMs / 1000)
    utimesSync(recentFile, recentMs / 1000, recentMs / 1000)

    cleanOldLogs(dir, 7)

    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(recentFile)).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/server/error-logger.test.ts -t "cleanOldLogs"`
Expected: FAIL — `errors-*.ndjson` 文件未被清理（现有 `cleanOldLogs` 只匹配 `llm-proxy.*.log`）

- [ ] **Step 3: 实现 cleanOldLogs 扩展**

修改 `src/server/logging.ts` 的 `cleanOldLogs` 函数（约第 155 行）。替换整个函数体：

```ts
const ERROR_LOG_RETENTION_DAYS = 30

export function cleanOldLogs(
  logDir: string = LOG_DIR,
  retentionDays: number = LOG_RETENTION_DAYS,
): void {
  const now = Date.now()
  const logCutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const errorCutoff = now - ERROR_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  try {
    for (const entry of readdirSync(logDir)) {
      const filePath = resolve(logDir, entry)
      let cutoff: number | undefined
      if (/^llm-proxy\.\d{4}-\d{2}-\d{2}\.log$/.test(entry)) {
        cutoff = logCutoff
      } else if (/^errors-\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry)) {
        cutoff = errorCutoff
      } else {
        continue
      }
      try {
        const stat = statSync(filePath)
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(filePath)
        }
      } catch {
        // Skip files that disappear or are inaccessible
      }
    }
  } catch {
    // Directory may not exist yet — nothing to clean
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/server/error-logger.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/logging.ts test/server/error-logger.test.ts
git commit -m "feat(logging): extend cleanOldLogs for 30-day error log rotation"
```

---

### Task 5: AppDependencies 与 createApp 装配

**Files:**

- Modify: `src/server/types.ts:35-47`（`AppDependencies` 接口）
- Modify: `src/server/app.ts`（`createApp` 解构与 `ErrorLogger` 创建）

- [ ] **Step 1: 修改 AppDependencies 类型**

在 `src/server/types.ts` 顶部添加 import：

```ts
import type { ErrorLogger } from './error-logger.js'
```

在 `AppDependencies` 接口（约第 35 行 `codexCatalogCache?: CodexCatalogCache` 之后）添加：

```ts
  errorLogger?: ErrorLogger
```

- [ ] **Step 2: 修改 createApp 装配**

在 `src/server/app.ts` 顶部添加 import：

```ts
import { ErrorLogger } from './error-logger.js'
```

在 `createApp` 解构参数（约第 44 行 `codexCatalogCache,` 之后）添加：

```ts
  errorLogger,
```

在 `createApp` 函数体内、`const protocolCtx` 定义之前（约第 70 行）添加 `ErrorLogger` 单例创建：

```ts
const resolvedErrorLogger =
  errorLogger ??
  new ErrorLogger({
    logDir: process.env.LLM_PROXY_LOG_DIR ?? resolve(process.cwd(), 'logs'),
    enabled: settings.errorLogging.enabled,
    maxBodyLength: settings.errorLogging.maxBodyLength,
  })
```

注意：`ErrorLogger` 需要被传入 `handleProtocolRequest`。由于 `protocolCtx` 当前不含 errorLogger，需要扩展 `ProtocolContext`。见下一步。

- [ ] **Step 3: 扩展 ProtocolContext**

在 `src/server/handle-protocol.ts` 的 `ProtocolContext` 接口（约第 18 行）添加 `errorLogger` 字段。先在文件顶部添加 import：

```ts
import type { ErrorLogger } from './error-logger.js'
```

在 `ProtocolContext` 接口末尾（`resolveModel` 之后）添加：

```ts
errorLogger: ErrorLogger
```

在 `src/server/app.ts` 的 `protocolCtx` 对象字面量中添加：

```ts
    errorLogger: resolvedErrorLogger,
```

- [ ] **Step 4: 运行 typecheck 确认类型一致**

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 5: 运行全部测试确认无回归**

Run: `pnpm test`
Expected: 全部 PASS（此时 errorLogger 已注入但尚未在 handle-protocol 中使用）

- [ ] **Step 6: 提交**

```bash
git add src/server/types.ts src/server/app.ts src/server/handle-protocol.ts
git commit -m "feat(server): wire ErrorLogger into AppDependencies and ProtocolContext"
```

---

### Task 6: handle-protocol 接入 — 非流式 generate 错误落盘

**Files:**

- Modify: `src/server/handle-protocol.ts`（`handleUpstreamError` 函数 + generate catch 分支）
- Test: `test/server/error-logging-integration.test.ts`

- [ ] **Step 1: 写集成测试失败用例**

创建 `test/server/error-logging-integration.test.ts`：

```ts
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { ErrorLogger } from '../../src/server/error-logger.js'
import type { Settings } from '../../src/index.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { stubRegistry } from '../helpers/registry.js'

const tmpLogRoot = mkdtempSync(join(tmpdir(), 'errint-'))
afterAll(() => {
  rmSync(tmpLogRoot, { recursive: true, force: true })
})

let dirCounter = 0
function makeAppWithErrors(
  gateway: ReturnType<typeof makeGateway>,
  settingsOverrides?: Partial<Settings>,
) {
  // 每次调用用独立子目录，避免测试间共享错误日志文件导致计数断言失败
  const tmpLogDir = join(tmpLogRoot, `t${dirCounter++}`)
  const settings = makeSettings(
    {
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] },
        },
      },
    },
    { requestTimeoutMs: 30000, ...settingsOverrides },
  )
  const errorLogger = new ErrorLogger({
    logDir: tmpLogDir,
    enabled: settings.errorLogging.enabled,
    maxBodyLength: settings.errorLogging.maxBodyLength,
  })
  return {
    app: createApp({ settings, gateway, providerRegistry: stubRegistry, errorLogger }),
    tmpLogDir,
  }
}

function readErrors(tmpLogDir: string): any[] {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  try {
    const raw = readFileSync(join(tmpLogDir, `errors-${y}-${m}-${d}.ndjson`), 'utf8').trim()
    return raw ? raw.split('\n').map((l) => JSON.parse(l)) : []
  } catch {
    return []
  }
}

describe('error logging integration', () => {
  it('logs request + null response when non-streaming generate fails', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('upstream generate failed')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway)

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.phase).toBe('generate')
    expect(record.error.message).toBe('upstream generate failed')
    expect(record.error.stack).toContain('upstream generate failed')
    expect(record.response).toBeNull()
    expect((record.request as any).model).toBe('openrouter/chat')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/server/error-logging-integration.test.ts`
Expected: FAIL — 错误日志文件不存在（`readErrors` 返回 `[]`），`records.toHaveLength(1)` 失败

- [ ] **Step 3: 实现 handleUpstreamError 落盘**

修改 `src/server/handle-protocol.ts`。`handleUpstreamError` 当前签名（约第 233 行）扩展，新增可选参数 `errorLogCtx`。在文件顶部确认 import（Task 5 已添加）：

```ts
import type { ErrorLogger } from './error-logger.js'
```

在 `handleUpstreamError` 之前添加辅助类型，并修改函数：

```ts
interface ErrorLogContext {
  errorLogger: ErrorLogger
  request: unknown
  response: unknown[] | null
}

export function handleUpstreamError(
  c: Context<AppEnv>,
  error: unknown,
  formatErrors: ProtocolErrorFormatter,
  loginUrl: string,
  phase: ErrorPhase,
  errorLogCtx?: ErrorLogContext,
): Response {
  c.get('logger').error({ err: error, phase }, 'upstream request failed')

  if (errorLogCtx) {
    errorLogCtx.errorLogger.log({
      requestId: c.get('requestId'),
      phase,
      provider: c.get('provider') ?? '',
      requestedModel: c.get('requestedModel') ?? '',
      actualModel: c.get('actualModel') ?? '',
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack && { stack: error.stack }),
      },
      request: errorLogCtx.request,
      response: errorLogCtx.response,
    })
  }

  if (error instanceof OAuthError && error.code === 'auth_required') {
    const { body, status } = formatErrors.oauth(error.message, loginUrl)
    return c.json(body, status as 503)
  }
  if (error instanceof RequestTimeoutError) {
    const { body, status } = formatErrors.timeout()
    return c.json(body, status as 504)
  }
  const { body, status } = formatErrors.upstream()
  return c.json(body, status as 502)
}
```

然后在 generate 路径的 catch 分支（约第 227 行）传入上下文：

```ts
  } catch (error) {
    return handleUpstreamError(c, error, formatErrors, loginUrl, 'generate', {
      errorLogger: ctx.errorLogger,
      request,
      response: null,
    })
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/server/error-logging-integration.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/handle-protocol.ts test/server/error-logging-integration.test.ts
git commit -m "feat(server): log request+response on non-streaming generate errors"
```

---

### Task 7: handle-protocol 接入 — 流式错误落盘

**Files:**

- Modify: `src/server/handle-protocol.ts`（流式路径 + streamOnly 路径）
- Test: `test/server/error-logging-integration.test.ts`（追加流式测试）

- [ ] **Step 1: 写流式失败测试**

在 `test/server/error-logging-integration.test.ts` 追加 import 与测试：

```ts
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'

describe('error logging integration — streaming', () => {
  it('logs buffered chunks when stream errors mid-flight', async () => {
    const emittedChunks: ProxyStreamPart[] = [
      { type: 'text-delta', text: 'partial ' },
      { type: 'text-delta', text: 'response' },
    ]
    async function* errorStream(): AsyncIterable<ProxyStreamPart> {
      yield emittedChunks[0]!
      yield emittedChunks[1]!
      throw new Error('stream broke')
    }
    const gateway = makeGateway({ stream: () => errorStream() })
    const { app, tmpLogDir } = makeAppWithErrors(gateway)

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    // 流式响应已开始（200），错误在消费阶段
    expect(response.status).toBe(200)
    // 消费流以触发错误
    await response.text().catch(() => {})
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.phase).toBe('stream')
    expect(record.error.message).toBe('stream broke')
    expect(Array.isArray(record.response)).toBe(true)
    expect((record.response as any[]).length).toBe(2)
    expect((record.response as any[])[0].text).toBe('partial ')
  })

  it('logs empty response array when acquireStream fails before first chunk', async () => {
    const gateway = makeGateway({
      stream() {
        throw new Error('connection refused')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway)

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    const record = records.find(
      (r) => r.phase === 'stream' && r.error.message === 'connection refused',
    )
    expect(record).toBeDefined()
    expect(record.response).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/server/error-logging-integration.test.ts -t "streaming"`
Expected: FAIL — 流式错误未落盘

- [ ] **Step 3: 实现流式路径接入**

修改 `src/server/handle-protocol.ts`。在文件顶部添加 import：

```ts
import { teeStream } from './tee-stream.js'
```

修改流式路径（约第 130 行 `if (strategy.isStream(request))` 块内）。在 `acquireStream` 成功后、`renderStreamSSE` 之前插入 tee 包装，并修改 `onError` 回调闭包捕获 `request` 和 `buffer`：

```ts
const reqLogger = c.get('logger')
const enabled = ctx.settings.errorLogging.enabled
const buffer: ProxyStreamPart[] = []
const teedStream = enabled ? teeStream(acquired.stream, buffer) : acquired.stream
return new Response(
  readableStreamFromAsyncIterable(
    strategy.renderStreamSSE({
      model: requestModel,
      stream: teedStream,
      ...(customToolNames && { customToolNames }),
      ...(customToolShimmed && { customToolShimmed }),
      ...(toolSearchShimmed && { toolSearchShimmed }),
      ...(namespaceFlatMap && { namespaceFlatMap }),
    }),
    (error) => {
      reqLogger.error({ err: error }, 'stream consumption failed')
      ctx.errorLogger.log({
        requestId: c.get('requestId'),
        phase: 'stream',
        provider: c.get('provider') ?? '',
        requestedModel: c.get('requestedModel') ?? '',
        actualModel: c.get('actualModel') ?? '',
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack && { stack: error.stack }),
        },
        request,
        response: enabled ? buffer : [],
      })
    },
  ),
  { headers: { 'content-type': 'text/event-stream' } },
)
```

修改 streamOnly 路径（约第 170 行）。在 `acquireStream` 成功后插入 tee 包装，并在 catch 中落盘：

```ts
const enabled = ctx.settings.errorLogging.enabled
const buffer: ProxyStreamPart[] = []
const teedStream = enabled ? teeStream(acquired.stream, buffer) : acquired.stream
try {
  const collected = await withRequestTimeout(
    collectStreamResult(teedStream),
    ctx.settings.requestTimeoutMs,
    abortController,
  )
  // ... 原有 renderResult 逻辑不变 ...
} catch (error) {
  return handleUpstreamError(c, error, formatErrors, loginUrl, 'stream-only', {
    errorLogger: ctx.errorLogger,
    request,
    response: enabled ? buffer : [],
  })
}
```

修改流式路径的 `acquireStream` catch 分支（约第 162 行），传入空 buffer：

```ts
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'stream', {
        errorLogger: ctx.errorLogger,
        request,
        response: [],
      })
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/server/error-logging-integration.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/handle-protocol.ts test/server/error-logging-integration.test.ts
git commit -m "feat(server): log request+buffered chunks on streaming errors"
```

---

### Task 8: 超时场景落盘验证

**Files:**

- Test: `test/server/error-logging-integration.test.ts`（追加超时测试）

- [ ] **Step 1: 写超时测试**

在 `test/server/error-logging-integration.test.ts` 追加：

```ts
describe('error logging integration — timeout', () => {
  it('logs timeout error with correct phase', async () => {
    const gateway = makeGateway({
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('late')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway, { requestTimeoutMs: 5 })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(504)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    expect(records[0].phase).toBe('generate')
    expect(records[0].error.name).toBe('RequestTimeoutError')
  })
})
```

- [ ] **Step 2: 运行测试确认通过**

Run: `pnpm test test/server/error-logging-integration.test.ts -t "timeout"`
Expected: PASS（Task 6 已实现 generate 路径落盘，超时走同一 catch 分支）

注意：`RequestTimeoutError` 的 `name` 属性需要确认。若测试失败因为 `name` 不匹配，检查 `src/server/stream-utils.ts` 中 `RequestTimeoutError` 的定义，确保 `name` 为 `'RequestTimeoutError'`。如需显式设置，在该类构造函数中添加 `this.name = 'RequestTimeoutError'`。

- [ ] **Step 3: 提交**

```bash
git add test/server/error-logging-integration.test.ts
git commit -m "test(server): verify error logging on request timeout"
```

---

### Task 9: enabled=false 与脱敏集成验证

**Files:**

- Test: `test/server/error-logging-integration.test.ts`（追加）

- [ ] **Step 1: 写 enabled=false 测试**

在 `test/server/error-logging-integration.test.ts` 追加：

```ts
describe('error logging integration — disabled', () => {
  it('writes nothing when errorLogging.enabled is false', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('should not be logged')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway, {
      errorLogging: { enabled: false, maxBodyLength: 262144 },
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    expect(records.find((r) => r.error.message === 'should not be logged')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 写脱敏集成测试**

继续追加：

```ts
describe('error logging integration — redaction', () => {
  it('redacts authorization field from logged request body', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('redact test')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway)

    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        authorization: 'Bearer super-secret',
      }),
    })

    const records = readErrors(tmpLogDir)
    const record = records.find((r) => r.error.message === 'redact test')!
    expect((record.request as any).authorization).toBe('[REDACTED]')
  })
})
```

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm test test/server/error-logging-integration.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add test/server/error-logging-integration.test.ts
git commit -m "test(server): verify disabled flag and authorization redaction"
```

---

### Task 10: schema 重新生成与最终验证

**Files:**

- Modify: `config/settings.schema.json`（自动生成）

- [ ] **Step 1: 重新生成 JSON schema**

Run: `pnpm generate:schema`
Expected: `config/settings.schema.json` 更新，包含 `errorLogging` 属性

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 4: 格式检查**

Run: `pnpm format:check`
Expected: 无错误（如有格式问题运行 `pnpm format`）

- [ ] **Step 5: 提交**

```bash
git add config/settings.schema.json
git commit -m "chore: regenerate settings schema with errorLogging"
```

- [ ] **Step 6: 更新 AGENTS.md**

在 `AGENTS.md` 的「核心模块」`src/server/` 条目末尾补充一句关于 `error-logger.ts` 的描述，在「关键设计决策」补充一条错误日志设计要点。保持文档精简，只描述当前事实。

```bash
git add AGENTS.md
git commit -m "docs: document error logging feature"
```
