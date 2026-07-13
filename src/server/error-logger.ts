import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { redact, logger as fallbackLogger } from './logging.js'

export const ERROR_LOG_RETENTION_DAYS = 30

/** 错误日志记录的 phase — 由 error-logger 拥有,handle-protocol 导入 */
export type ErrorPhase = 'stream' | 'stream-only' | 'generate'

export interface ErrorLogEntry {
  timestamp: string
  requestId: string
  phase: ErrorPhase
  provider: string
  requestedModel: string
  actualModel: string
  error: {
    name: string
    message: string
    stack?: string
    code?: string
    statusCode?: number
    responseBody?: string
    isRetryable?: boolean
  }
  request: unknown
  response: unknown
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

export function getErrorLogFileName(date: Date = new Date()): string {
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
      appendFileSync(filePath, `${line}\n`)
    } catch (err) {
      fallbackLogger.error(
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
export function normalizeErrorForLog(error: unknown): ErrorLogEntry['error'] {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined
  const lastError =
    typeof record?.lastError === 'object' && record.lastError !== null
      ? (record.lastError as Record<string, unknown>)
      : undefined
  const details = lastError ?? record

  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack && { stack: error.stack }),
    ...(typeof record?.code === 'string' && { code: record.code }),
    ...(typeof details?.statusCode === 'number' && { statusCode: details.statusCode }),
    ...(typeof details?.responseBody === 'string' && { responseBody: details.responseBody }),
    ...(typeof details?.isRetryable === 'boolean' && { isRetryable: details.isRetryable }),
  }
}
