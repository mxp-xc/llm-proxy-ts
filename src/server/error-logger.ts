import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatCNDate, formatCNTimestamp, redact } from './logging.js'
import { RequestTimeoutError } from '../request-timeout.js'
import type { KeySelection } from '../providers/registry.js'
import type { Logger } from '../types.js'

export const ERROR_LOG_RETENTION_DAYS = 30

/** 错误日志记录的 phase — 由 error-logger 拥有,handle-protocol 导入 */
export type ErrorPhase = 'stream' | 'stream-only' | 'generate'

export interface NormalizedErrorForLog {
  name: string
  message: string
  stack?: string
  code?: string
  statusCode?: number
  responseBodyBytes?: number
  upstreamErrorType?: string
  upstreamErrorCode?: string
  isRetryable?: boolean
  retryReason?: string
  attempts?: number
  timeoutMs?: number
  plugin?: string
  provider?: string
  hook?: string
  cause?: NormalizedErrorForLog
}

export interface ErrorLogEntry {
  timestamp: string
  requestId: string
  phase: ErrorPhase
  provider: string
  requestedModel: string
  actualModel: string
  error: NormalizedErrorForLog
  keySelection?: KeySelection
  request: unknown
  response: unknown
}

export interface ErrorLoggerOptions {
  logDir: string
  enabled: boolean
  maxBodyLength: number
  logger: Logger
}

const PREVIEW_LENGTH = 1024
const REDACTED_UPSTREAM_ERROR_MESSAGE = 'Upstream provider request failed'

export function getErrorLogFileName(date: Date = new Date()): string {
  return `errors-${formatCNDate(date)}.ndjson`
}

/** 截断超大 body：序列化后超限则替换为 { _truncated, originalLength, preview } */
function truncateBody(value: unknown, maxBodyLength: number): unknown {
  const redacted = redact(value)
  const serialized = JSON.stringify(redacted)
  if (serialized === undefined) return redacted
  if (serialized.length <= maxBodyLength) {
    return redacted
  }
  return {
    _truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, Math.min(PREVIEW_LENGTH, maxBodyLength)),
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
  private readonly logger: Logger

  constructor(opts: ErrorLoggerOptions) {
    this.logDir = opts.logDir
    this.enabled = opts.enabled
    this.maxBodyLength = opts.maxBodyLength
    this.logger = opts.logger
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
      appendFileSync(filePath, `${line}\n`)
    } catch (err) {
      this.logger.error(
        {
          err,
          requestId: entry.requestId,
          phase: entry.phase,
          provider: entry.provider,
          requestedModel: entry.requestedModel,
          actualModel: entry.actualModel,
        },
        'error log write failed',
      )
    }
  }
}

/** 将任意错误值安全转换为 ErrorLogEntry.error 形状 */
export function normalizeErrorForLog(error: unknown): NormalizedErrorForLog {
  return normalizeError(error, new Set(), 0)
}

function normalizeError(error: unknown, seen: Set<object>, depth: number): NormalizedErrorForLog {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined
  if (record && seen.has(record)) {
    return { name: 'Error', message: '[Circular error cause]' }
  }
  if (record) seen.add(record)
  const lastError =
    typeof record?.lastError === 'object' && record.lastError !== null
      ? (record.lastError as Record<string, unknown>)
      : undefined
  const details = lastError ?? record
  const responseBody = typeof details?.responseBody === 'string' ? details.responseBody : undefined
  const { upstreamErrorMessage, ...upstreamError } = extractUpstreamError(responseBody)
  const errorName = error instanceof Error ? error.name : 'Error'
  const apiCallErrorMessage =
    errorName === 'AI_APICallError' && error instanceof Error
      ? error.message
      : errorName === 'AI_RetryError' &&
          lastError?.name === 'AI_APICallError' &&
          typeof lastError.message === 'string'
        ? lastError.message
        : undefined
  const apiCallMessageAppearsInResponseBody =
    responseBody !== undefined &&
    apiCallErrorMessage !== undefined &&
    apiCallErrorMessage.length > 0 &&
    (responseBody === apiCallErrorMessage ||
      responseBody.includes(JSON.stringify(apiCallErrorMessage)) ||
      (upstreamErrorMessage !== undefined && apiCallErrorMessage.includes(upstreamErrorMessage)))
  const hasResponseBodyDerivedText =
    apiCallMessageAppearsInResponseBody &&
    (errorName === 'AI_APICallError' ||
      (error instanceof Error && error.message.includes(apiCallErrorMessage)))
  const errorMessage =
    error instanceof Error
      ? hasResponseBodyDerivedText
        ? REDACTED_UPSTREAM_ERROR_MESSAGE
        : error.message
      : String(error)
  const retryReason = safeUpstreamValue(record?.reason)
  const statusCode =
    typeof details?.statusCode === 'number'
      ? details.statusCode
      : typeof details?.status === 'number'
        ? details.status
        : undefined
  const cause =
    depth < 4 && record?.cause !== undefined
      ? normalizeError(record.cause, seen, depth + 1)
      : undefined

  return {
    name: errorName,
    message: errorMessage,
    ...(!hasResponseBodyDerivedText &&
      error instanceof Error &&
      error.stack && { stack: error.stack }),
    ...(typeof record?.code === 'string' && { code: record.code }),
    ...(statusCode !== undefined && { statusCode }),
    ...(responseBody !== undefined && {
      responseBodyBytes: Buffer.byteLength(responseBody, 'utf8'),
    }),
    ...upstreamError,
    ...(typeof details?.isRetryable === 'boolean' && { isRetryable: details.isRetryable }),
    ...(retryReason !== undefined && { retryReason }),
    ...(Array.isArray(record?.errors) && { attempts: record.errors.length }),
    ...(error instanceof RequestTimeoutError && { timeoutMs: error.timeoutMs }),
    ...(typeof record?.plugin === 'string' && { plugin: record.plugin }),
    ...(typeof record?.provider === 'string' && { provider: record.provider }),
    ...(typeof record?.hook === 'string' && { hook: record.hook }),
    ...(cause !== undefined && { cause }),
  }
}

const SAFE_UPSTREAM_VALUE_LENGTH = 256

function safeUpstreamValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.slice(0, SAFE_UPSTREAM_VALUE_LENGTH)
}

function extractUpstreamError(responseBody: string | undefined): {
  upstreamErrorType?: string
  upstreamErrorCode?: string
  upstreamErrorMessage?: string
} {
  if (responseBody === undefined) return {}
  try {
    const parsed = JSON.parse(responseBody) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const candidate = (parsed as Record<string, unknown>).error
    if (typeof candidate !== 'object' || candidate === null) return {}
    const upstream = candidate as Record<string, unknown>
    const upstreamErrorType = safeUpstreamValue(upstream.type)
    const upstreamErrorCode = safeUpstreamValue(upstream.code)
    const upstreamErrorMessage =
      typeof upstream.message === 'string' && upstream.message.length > 0
        ? upstream.message
        : undefined
    return {
      ...(upstreamErrorType !== undefined && { upstreamErrorType }),
      ...(upstreamErrorCode !== undefined && { upstreamErrorCode }),
      ...(upstreamErrorMessage !== undefined && { upstreamErrorMessage }),
    }
  } catch {
    return {}
  }
}
