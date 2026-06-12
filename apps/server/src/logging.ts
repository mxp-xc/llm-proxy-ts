import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Writable } from 'node:stream'
import pino from 'pino'

// --- Environment variable configuration ---

const LOG_LEVEL = process.env.LLM_PROXY_LOG_LEVEL ?? 'info'
const LOG_DIR = process.env.LLM_PROXY_LOG_DIR ?? resolve(process.cwd(), 'logs')
const LOG_FORMAT = process.env.LLM_PROXY_LOG_FORMAT ?? 'pretty'
const LOG_RETENTION_DAYS = 7

// --- Redaction ---

const secretKeys = new Set([
  'apikey',
  'api_key',
  'authorization',
  'x-api-key',
  'proxy-authorization',
])

// --- Plain text log format ---

const baseLogKeys = new Set(['level', 'time', 'pid', 'hostname', 'name', 'msg'])
const orderedFieldKeys = [
  'requestId',
  'method',
  'path',
  'status',
  'durationMs',
  'provider',
  'requestedModel',
  'actualModel',
  'keySelection',
  'host',
  'port',
]

function formatLocalTime(value: unknown): string {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}:${s}`
}

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

function formatPlainLogLine(log: Record<string, unknown>): string {
  const level =
    typeof log.level === 'number'
      ? (pino.levels.labels[log.level]?.toUpperCase() ?? String(log.level))
      : String(log.level ?? 'INFO')
  const name = typeof log.name === 'string' ? log.name : 'llm-proxy'
  const message = typeof log.msg === 'string' ? log.msg : ''
  return `${formatLocalTime(log.time)} ${level.padEnd(5)} ${name} - ${message}${formatFields(log)}`
}

function plainTextStream(destination: NodeJS.WritableStream): Writable {
  let buffered = ''

  return new Writable({
    write(chunk, _encoding, callback) {
      buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''

      const output = lines
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return formatPlainLogLine(JSON.parse(line) as Record<string, unknown>)
          } catch {
            return line
          }
        })
        .join('\n')

      if (output.length === 0) {
        callback()
        return
      }
      destination.write(`${output}\n`, callback)
    },
    final(callback) {
      if (buffered.length === 0) {
        callback()
        return
      }
      try {
        destination.write(
          `${formatPlainLogLine(JSON.parse(buffered) as Record<string, unknown>)}\n`,
          callback,
        )
      } catch {
        destination.write(`${buffered}\n`, callback)
      }
    },
  })
}

// --- Log file rotation & cleanup ---

function getLogFileName(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `llm-proxy.${y}-${m}-${d}.log`
}

export function cleanOldLogs(
  logDir: string = LOG_DIR,
  retentionDays: number = LOG_RETENTION_DAYS,
): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  try {
    for (const entry of readdirSync(logDir)) {
      const filePath = resolve(logDir, entry)
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

// --- Logger factory ---

export function createLogger(options?: pino.LoggerOptions): pino.Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: LOG_LEVEL,
    name: 'llm-proxy',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['apiKey', '*.apiKey', 'authorization', '*.authorization'],
      censor: '[REDACTED]',
    },
    ...options,
  }

  try {
    const streams: pino.StreamEntry[] = []

    // Stdout defaults to the same plain text format as log files.
    if (LOG_FORMAT === 'pretty') {
      streams.push({ level: LOG_LEVEL as pino.Level, stream: plainTextStream(process.stdout) })
    } else {
      streams.push({ level: LOG_LEVEL as pino.Level, stream: process.stdout })
    }

    // File logs use a stable Java/Python-style plain text format.
    // Daily rotation is achieved by including the date in the filename.
    // Old log files are cleaned up on startup via cleanOldLogs().
    const logFilePath = resolve(LOG_DIR, getLogFileName())
    mkdirSync(resolve(LOG_DIR), { recursive: true })
    const fileStream = createWriteStream(logFilePath, { flags: 'a' })

    streams.push({ level: 'trace' as pino.Level, stream: plainTextStream(fileStream) })

    return pino(pinoOptions, pino.multistream(streams))
  } catch {
    // Fallback: if transport pipeline fails (e.g. worker thread unavailable),
    // fall back to simple stdout logger so the server can still start.
    return pino({
      level: LOG_LEVEL,
      name: 'llm-proxy',
      ...options,
    })
  }
}

export const logger = createLogger()

// Clean old log files on startup
cleanOldLogs()

// --- Utility exports (unchanged) ---

export function requestId(): string {
  return randomUUID()
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        secretKeys.has(key.toLowerCase()) ? '[REDACTED]' : redact(child),
      ]),
    )
  }

  return value
}

export function safeProxyHost(proxyUrl: string): string {
  return new URL(proxyUrl).host
}
