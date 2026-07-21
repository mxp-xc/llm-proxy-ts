import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Writable } from 'node:stream'
import pino, { type Logger as PinoLogger } from 'pino'
import { safeProxyHost, safeProxyUrl } from '../proxy-url.js'
import type { Logger } from '../types.js'

const LOG_RETENTION_DAYS = 7
const ERROR_LOG_RETENTION_DAYS = 30
const REDACTED = '[REDACTED]'
const CN_OFFSET_MS = 8 * 60 * 60 * 1000

const secretKeys = new Set([
  'apikey',
  'api_key',
  'api-key',
  'token',
  'access_token',
  'access-token',
  'accesstoken',
  'refresh_token',
  'refresh-token',
  'refreshtoken',
  'id_token',
  'id-token',
  'idtoken',
  'client_secret',
  'client-secret',
  'clientsecret',
  'secret',
  'password',
  'authorization',
  'x-api-key',
  'proxy-authorization',
  'cookie',
  'set-cookie',
])

const errorSecretKeys = new Set(['responsebody', 'responseheaders', 'headers'])

const pinoRedactPaths = [...secretKeys, ...errorSecretKeys].flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
])

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
const logFormats = ['pretty', 'json'] as const

export type LoggingLevel = (typeof logLevels)[number]
export type LoggingFormat = (typeof logFormats)[number]

export interface LoggingOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  now?: () => Date
  createFileStream?: (filePath: string) => Writable
  cleanupFileSystem?: CleanupFileSystem
}

export type LoggingRuntimeOptions = LoggingOptions

export interface LoggingRuntime {
  logger: Logger
  logDir: string
  close(): Promise<void>
}

interface CleanupFileSystem {
  readdirSync(path: string): string[]
  statSync(path: string): { isFile(): boolean; mtimeMs: number }
  unlinkSync(path: string): void
}

export interface CleanOldLogsOptions {
  now?: Date
  onError?: (err: unknown, context: { operation: 'read' | 'stat' | 'delete'; path: string }) => void
  fileSystem?: CleanupFileSystem
}

interface ResolvedLoggingOptions {
  level: LoggingLevel
  format: LoggingFormat
  logDir: string
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  now: () => Date
  createFileStream: (filePath: string) => Writable
  cleanupFileSystem: CleanupFileSystem | undefined
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function shouldRedactKey(key: string): boolean {
  const normalizedKey = key.toLowerCase()
  return secretKeys.has(normalizedKey) || errorSecretKeys.has(normalizedKey)
}

function shiftedCNDate(date: Date): Date {
  return new Date(date.getTime() + CN_OFFSET_MS)
}

/** Format a date in China time as YYYY-MM-DD. */
export function formatCNDate(date: Date = new Date()): string {
  const cn = shiftedCNDate(date)
  const year = cn.getUTCFullYear()
  const month = String(cn.getUTCMonth() + 1).padStart(2, '0')
  const day = String(cn.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Format a date in China time as YYYY-MM-DD HH:mm:ss. */
export function formatCNTimestamp(date: Date = new Date()): string {
  const cn = shiftedCNDate(date)
  const hours = String(cn.getUTCHours()).padStart(2, '0')
  const minutes = String(cn.getUTCMinutes()).padStart(2, '0')
  const seconds = String(cn.getUTCSeconds()).padStart(2, '0')
  return `${formatCNDate(date)} ${hours}:${minutes}:${seconds}`
}

export function getLogFileName(date: Date = new Date()): string {
  return `llm-proxy.${formatCNDate(date)}.log`
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }

  const existing = seen.get(value)
  if (existing !== undefined) {
    return existing
  }

  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    }
    seen.set(value, result)
    if (value.stack !== undefined) {
      result.stack = value.stack
    }
    if ('cause' in value && value.cause !== undefined) {
      result.cause = redactValue(value.cause, seen)
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
        continue
      }
      setOwn(result, key, shouldRedactKey(key) ? REDACTED : redactValue(child, seen))
    }
    return result
  }

  if (Array.isArray(value)) {
    const result: unknown[] = []
    seen.set(value, result)
    for (const item of value) {
      result.push(redactValue(item, seen))
    }
    return result
  }

  if (value instanceof Date) {
    return new Date(value.getTime())
  }

  const result: Record<string, unknown> = {}
  seen.set(value, result)
  for (const [key, child] of Object.entries(value)) {
    setOwn(result, key, shouldRedactKey(key) ? REDACTED : redactValue(child, seen))
  }
  return result
}

export function redact(value: unknown): unknown {
  return redactValue(value, new WeakMap())
}

const baseLogKeys = new Set(['level', 'time', 'pid', 'hostname', 'name', 'msg'])
const orderedFieldKeys = [
  'requestId',
  'method',
  'path',
  'url',
  'status',
  'outcome',
  'durationMs',
  'provider',
  'requestedModel',
  'actualModel',
  'executionMode',
  'keySelection',
  'upstreamDurationMs',
  'firstChunkMs',
  'finishReason',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'reasoningTokens',
  'upstreamRequestId',
  'host',
  'port',
]

function formatFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'string') {
    return /^[-./:@\w]+$/.test(value) ? value : JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

function formatFields(log: Record<string, unknown>): string {
  const seen = new Set(baseLogKeys)
  const fields: string[] = []

  for (const key of orderedFieldKeys) {
    seen.add(key)
    const value = formatFieldValue(log[key])
    if (value !== undefined) {
      fields.push(`${key}=${value}`)
    }
  }

  for (const [key, rawValue] of Object.entries(log)) {
    if (seen.has(key)) {
      continue
    }
    const value = formatFieldValue(rawValue)
    if (value !== undefined) {
      fields.push(`${key}=${value}`)
    }
  }

  return fields.length > 0 ? ` ${fields.join(' ')}` : ''
}

export function formatPlainLogLine(log: Record<string, unknown>): string {
  const level =
    typeof log.level === 'number'
      ? (pino.levels.labels[log.level]?.toUpperCase() ?? String(log.level))
      : String(log.level ?? 'INFO').toUpperCase()
  const name = typeof log.name === 'string' ? log.name : 'llm-proxy'
  const message = typeof log.msg === 'string' ? log.msg : ''
  const time = new Date(
    typeof log.time === 'string' || typeof log.time === 'number' ? log.time : Date.now(),
  )
  const timestamp = Number.isNaN(time.getTime()) ? String(log.time) : formatCNTimestamp(time)
  return `${timestamp} ${level.padEnd(5)} ${name} - ${message}${formatFields(log)}`
}

function isErrnoException(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code
}

export function cleanOldLogs(
  logDir: string,
  retentionDays: number = LOG_RETENTION_DAYS,
  options: CleanOldLogsOptions = {},
): void {
  const fileSystem = options.fileSystem ?? { readdirSync, statSync, unlinkSync }
  const now = options.now?.getTime() ?? Date.now()
  const logCutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const errorCutoff = now - ERROR_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

  let entries: string[]
  try {
    entries = fileSystem.readdirSync(logDir)
  } catch (err) {
    if (!isErrnoException(err, 'ENOENT')) {
      options.onError?.(err, { operation: 'read', path: logDir })
    }
    return
  }

  for (const entry of entries) {
    const filePath = resolve(logDir, entry)
    let cutoff: number | undefined
    if (/^llm-proxy\.\d{4}-\d{2}-\d{2}\.log$/.test(entry)) {
      cutoff = logCutoff
    } else if (/^errors-\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry)) {
      cutoff = errorCutoff
    } else {
      continue
    }

    let shouldDelete = false
    try {
      const stat = fileSystem.statSync(filePath)
      shouldDelete = stat.isFile() && stat.mtimeMs < cutoff
    } catch (err) {
      if (!isErrnoException(err, 'ENOENT')) {
        options.onError?.(err, { operation: 'stat', path: filePath })
      }
      continue
    }

    if (!shouldDelete) {
      continue
    }
    try {
      fileSystem.unlinkSync(filePath)
    } catch (err) {
      if (!isErrnoException(err, 'ENOENT')) {
        options.onError?.(err, { operation: 'delete', path: filePath })
      }
    }
  }
}

function formatDiagnostic(
  message: string,
  err: unknown,
  context?: Record<string, unknown>,
): string {
  const details = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err)
  const fields = context === undefined ? '' : ` ${JSON.stringify(redact(context))}`
  return `[llm-proxy] ${message}${fields}\n${details}\n`
}

function safeWrite(destination: NodeJS.WritableStream, text: string): void {
  try {
    destination.write(text)
  } catch {
    // Logging must never take down the process.
  }
}

function safeWriteAsync(
  destination: NodeJS.WritableStream,
  text: string,
  callback: () => void,
): void {
  let completed = false
  const done = (): void => {
    if (completed) return
    completed = true
    callback()
  }
  try {
    destination.write(text, done)
  } catch {
    done()
  }
}

function finishWritable(stream: Writable): Promise<void> {
  if (stream.destroyed || stream.writableFinished) {
    return Promise.resolve()
  }
  return new Promise((resolvePromise) => {
    const done = (): void => {
      stream.off('finish', done)
      stream.off('close', done)
      stream.off('error', done)
      resolvePromise()
    }
    stream.once('finish', done)
    stream.once('close', done)
    stream.once('error', done)
    stream.end()
  })
}

class RotatingFileDestination {
  private enabled: boolean
  private failureReported = false
  private activeDate: string | undefined
  private activeFilePath: string | undefined
  private activeStream: Writable | undefined
  private readonly closingStreams = new Set<Promise<void>>()

  constructor(
    private readonly options: ResolvedLoggingOptions,
    enabled: boolean,
    private lastCleanupDate: string | undefined,
    private readonly onCleanupError: NonNullable<CleanOldLogsOptions['onError']>,
  ) {
    this.enabled = enabled
  }

  write(line: string, callback: () => void): void {
    if (!this.enabled) {
      callback()
      return
    }

    const stream = this.activeStream
    const filePath = this.activeFilePath
    if (stream === undefined || filePath === undefined) {
      callback()
      return
    }
    let completed = false
    const done = (err?: Error | null): void => {
      if (completed) return
      completed = true
      if (err) {
        this.disable(err, filePath)
      }
      callback()
    }
    try {
      stream.write(line, done)
    } catch (err) {
      this.disable(err, filePath)
      done()
    }
  }

  prepare(): void {
    if (!this.enabled) return
    const now = this.options.now()
    const date = formatCNDate(now)
    if (date !== this.activeDate) {
      this.rotate(date, now)
    }
  }

  async close(): Promise<void> {
    this.enabled = false
    const active = this.activeStream
    this.activeStream = undefined
    this.activeFilePath = undefined
    if (active !== undefined) {
      this.trackClose(active)
    }
    await Promise.all(this.closingStreams)
  }

  private rotate(date: string, now: Date): void {
    const previous = this.activeStream
    this.activeStream = undefined
    this.activeFilePath = undefined
    this.activeDate = date
    if (previous !== undefined) {
      this.trackClose(previous)
    }

    const filePath = resolve(this.options.logDir, `llm-proxy.${date}.log`)
    try {
      const stream = this.options.createFileStream(filePath)
      stream.on('error', (err) => this.disable(err, filePath))
      this.activeStream = stream
      this.activeFilePath = filePath
    } catch (err) {
      this.disable(err, filePath)
    }

    if (this.lastCleanupDate !== date) {
      this.lastCleanupDate = date
      cleanOldLogs(this.options.logDir, LOG_RETENTION_DAYS, {
        now,
        onError: this.onCleanupError,
        ...(this.options.cleanupFileSystem === undefined
          ? {}
          : { fileSystem: this.options.cleanupFileSystem }),
      })
    }
  }

  private trackClose(stream: Writable): void {
    const closePromise = finishWritable(stream)
    this.closingStreams.add(closePromise)
    void closePromise.finally(() => this.closingStreams.delete(closePromise))
  }

  private disable(err: unknown, filePath: string): void {
    this.enabled = false
    const active = this.activeStream
    this.activeStream = undefined
    this.activeFilePath = undefined
    if (active !== undefined && !active.destroyed) {
      active.destroy()
    }
    if (this.failureReported) {
      return
    }
    this.failureReported = true
    safeWrite(
      this.options.stderr,
      formatDiagnostic('log file output failed; file logging disabled', err, { filePath }),
    )
  }
}

class RuntimeDestination extends Writable {
  private buffered = ''
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly options: ResolvedLoggingOptions,
    private readonly fileDestination: RotatingFileDestination,
  ) {
    super()
  }

  close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = new Promise<void>((resolvePromise) => {
        this.once('finish', () => {
          void this.fileDestination.close().then(resolvePromise)
        })
        this.end()
      })
    }
    return this.closePromise
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    const lines = this.buffered.split(/\r?\n/)
    this.buffered = lines.pop() ?? ''
    this.writeLines(
      lines.filter((line) => line.length > 0),
      callback,
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.buffered.length === 0) {
      callback()
      return
    }
    const line = this.buffered
    this.buffered = ''
    this.writeLine(line, callback)
  }

  private writeLines(lines: string[], callback: () => void): void {
    let index = 0
    const writeNext = (): void => {
      const line = lines[index]
      if (line === undefined) {
        callback()
        return
      }
      index += 1
      this.writeLine(line, writeNext)
    }
    writeNext()
  }

  private writeLine(jsonLine: string, callback: () => void): void {
    let fileLine = jsonLine
    let stdoutLine = jsonLine
    try {
      const record = JSON.parse(jsonLine) as Record<string, unknown>
      fileLine = formatPlainLogLine(record)
      if (this.options.format === 'pretty') {
        stdoutLine = fileLine
      }
    } catch {
      // Preserve an unexpected Pino line rather than dropping it.
    }
    let pendingWrites = 2
    const writeCompleted = (): void => {
      pendingWrites -= 1
      if (pendingWrites === 0) {
        callback()
      }
    }
    safeWriteAsync(this.options.stdout, `${stdoutLine}\n`, writeCompleted)
    this.fileDestination.write(`${fileLine}\n`, writeCompleted)
  }
}

function resolveLoggingOptions(options: LoggingOptions): ResolvedLoggingOptions {
  const env = options.env ?? process.env
  const level = env.LLM_PROXY_LOG_LEVEL ?? 'info'
  if (!logLevels.includes(level as LoggingLevel)) {
    throw new Error(
      `Invalid LLM_PROXY_LOG_LEVEL ${JSON.stringify(level)}; expected one of: ${logLevels.join(', ')}`,
    )
  }
  const format = env.LLM_PROXY_LOG_FORMAT ?? 'pretty'
  if (!logFormats.includes(format as LoggingFormat)) {
    throw new Error(
      `Invalid LLM_PROXY_LOG_FORMAT ${JSON.stringify(format)}; expected one of: ${logFormats.join(', ')}`,
    )
  }

  const cwd = options.cwd ?? process.cwd()
  return {
    level: level as LoggingLevel,
    format: format as LoggingFormat,
    logDir: resolve(cwd, env.LLM_PROXY_LOG_DIR ?? 'logs'),
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    now: options.now ?? (() => new Date()),
    createFileStream:
      options.createFileStream ?? ((filePath) => createWriteStream(filePath, { flags: 'a' })),
    cleanupFileSystem: options.cleanupFileSystem,
  }
}

function normalizePayload(payload: unknown): unknown {
  const safePayload = redact(payload)
  if (
    safePayload !== null &&
    typeof safePayload === 'object' &&
    !Array.isArray(safePayload) &&
    !(safePayload instanceof Date)
  ) {
    return safePayload
  }
  return { value: safePayload }
}

function createLoggerAdapter(
  base: PinoLogger,
  state: { closed: boolean },
  beforeLog: () => void,
): Logger {
  const log = (
    level: 'info' | 'warn' | 'error' | 'fatal',
    payload: unknown,
    msg?: string,
  ): void => {
    if (state.closed) {
      return
    }
    beforeLog()
    if (typeof payload === 'string' && msg === undefined) {
      base[level](payload)
      return
    }
    base[level](normalizePayload(payload), msg)
  }

  return {
    info(payload, msg) {
      log('info', payload, msg)
    },
    warn(payload, msg) {
      log('warn', payload, msg)
    },
    error(payload, msg) {
      log('error', payload, msg)
    },
    fatal(payload, msg) {
      log('fatal', payload, msg)
    },
    child(bindings) {
      return createLoggerAdapter(
        base.child(redact(bindings) as Record<string, unknown>),
        state,
        beforeLog,
      )
    },
  }
}

export function createLoggingRuntime(options: LoggingOptions = {}): LoggingRuntime {
  const resolvedOptions = resolveLoggingOptions(options)
  const cleanupFailures: Array<{
    err: unknown
    context: Parameters<NonNullable<CleanOldLogsOptions['onError']>>[1]
  }> = []
  let reportCleanupError: NonNullable<CleanOldLogsOptions['onError']> = (err, context) => {
    cleanupFailures.push({ err, context })
  }

  let fileOutputEnabled = true
  let directoryError: unknown
  try {
    mkdirSync(resolvedOptions.logDir, { recursive: true })
  } catch (err) {
    fileOutputEnabled = false
    directoryError = err
  }
  let lastCleanupDate: string | undefined
  if (fileOutputEnabled) {
    const cleanupNow = resolvedOptions.now()
    lastCleanupDate = formatCNDate(cleanupNow)
    cleanOldLogs(resolvedOptions.logDir, LOG_RETENTION_DAYS, {
      now: cleanupNow,
      onError: reportCleanupError,
      ...(resolvedOptions.cleanupFileSystem === undefined
        ? {}
        : { fileSystem: resolvedOptions.cleanupFileSystem }),
    })
  }

  const fileDestination = new RotatingFileDestination(
    resolvedOptions,
    fileOutputEnabled,
    lastCleanupDate,
    (err, context) => reportCleanupError(err, context),
  )
  const destination = new RuntimeDestination(resolvedOptions, fileDestination)
  const state = { closed: false }
  const pinoLogger = pino(
    {
      level: resolvedOptions.level,
      name: 'llm-proxy',
      timestamp: () => `,"time":"${resolvedOptions.now().toISOString()}"`,
      redact: { paths: pinoRedactPaths, censor: REDACTED },
    },
    destination,
  )
  const logger = createLoggerAdapter(pinoLogger, state, () => fileDestination.prepare())
  let closePromise: Promise<void> | undefined

  const logCleanupError: NonNullable<CleanOldLogsOptions['onError']> = (err, context) => {
    logger.warn(
      {
        err,
        operation: context.operation,
        logDir: resolvedOptions.logDir,
        filePath: context.path,
      },
      'logging.cleanup_failed',
    )
  }
  reportCleanupError = logCleanupError

  if (directoryError !== undefined) {
    logger.warn(
      { err: directoryError, logDir: resolvedOptions.logDir },
      'logging.file_output_disabled',
    )
  }
  for (const { err, context } of cleanupFailures) {
    logCleanupError(err, context)
  }

  return {
    logger,
    logDir: resolvedOptions.logDir,
    close() {
      if (closePromise === undefined) {
        state.closed = true
        closePromise = destination.close()
      }
      return closePromise
    },
  }
}

export function requestId(): string {
  return randomUUID()
}

export { safeProxyHost, safeProxyUrl }
