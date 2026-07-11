import { createParser, type EventSourceMessage } from 'eventsource-parser'
import type { ProxyPlugin, PluginContext, PluginResponse } from '../types.js'

export interface VendorSseErrorConfig {
  maxPreviewEvents?: number
  maxPreviewBytes?: number
  rateLimitCodes?: string[]
}

export interface VendorSseErrorResponse {
  status: number
  body: unknown
}

interface NormalizedVendorSseErrorConfig {
  maxPreviewEvents: number
  maxPreviewBytes: number
  rateLimitCodes: string[]
}

const DEFAULT_MAX_PREVIEW_EVENTS = 3
const DEFAULT_MAX_PREVIEW_BYTES = 65536
const DEFAULT_RATE_LIMIT_CODES = ['rate_limit', 'too_many_requests', 'rate_limit_error']

export function inspectVendorSseError(
  config: VendorSseErrorConfig,
  chunk: unknown,
): VendorSseErrorResponse | undefined {
  const normalized = normalizeVendorSseErrorConfig(config)
  const raw = extractRaw(chunk)
  if (!raw) {
    return undefined
  }

  const preview = raw.slice(0, normalized.maxPreviewBytes)
  const dataItems = extractSseData(preview, normalized.maxPreviewEvents)

  for (const data of dataItems) {
    if (data === '[DONE]') {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }

    const error = extractError(parsed)
    if (!error) {
      continue
    }

    const code = safeString(error.code)
    const type = safeString(error.type)
    if (
      !normalized.rateLimitCodes.includes(code ?? '') &&
      !normalized.rateLimitCodes.includes(type ?? '')
    ) {
      continue
    }

    return {
      status: 429,
      body: {
        error: {
          message: 'Rate limited by upstream provider',
          code,
          type,
        },
      },
    }
  }

  return undefined
}

// ─── Built-in Plugin ─────────────────────────────────────────────

function isVendorSseErrorConfig(value: unknown): value is VendorSseErrorConfig {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  if ('maxPreviewEvents' in obj && typeof obj.maxPreviewEvents !== 'number') return false
  if ('maxPreviewBytes' in obj && typeof obj.maxPreviewBytes !== 'number') return false
  if (
    'rateLimitCodes' in obj &&
    !(
      Array.isArray(obj.rateLimitCodes) &&
      (obj.rateLimitCodes as unknown[]).every((v) => typeof v === 'string')
    )
  )
    return false
  return true
}

export const vendorSseErrorPlugin: ProxyPlugin = {
  name: 'vendor_sse_error',

  inspectStreamChunk(ctx: PluginContext & { chunk: unknown }): Promise<void | PluginResponse> {
    const config = isVendorSseErrorConfig(ctx.config) ? ctx.config : {}
    const result = inspectVendorSseError(config, ctx.chunk)
    if (result) {
      return Promise.resolve(result)
    }
    return Promise.resolve()
  },
}

// ─── Internal helpers ────────────────────────────────────────────

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

function normalizeVendorSseErrorConfig(
  config: VendorSseErrorConfig,
): NormalizedVendorSseErrorConfig {
  return {
    maxPreviewEvents: normalizePositiveInteger(config.maxPreviewEvents, DEFAULT_MAX_PREVIEW_EVENTS),
    maxPreviewBytes: normalizePositiveInteger(config.maxPreviewBytes, DEFAULT_MAX_PREVIEW_BYTES),
    rateLimitCodes: config.rateLimitCodes ?? DEFAULT_RATE_LIMIT_CODES,
  }
}

function extractRaw(chunk: unknown): string | undefined {
  if (typeof chunk === 'string') {
    return chunk
  }
  if (chunk instanceof Uint8Array) {
    return new TextDecoder().decode(chunk)
  }
  if (
    chunk &&
    typeof chunk === 'object' &&
    'rawValue' in chunk &&
    typeof chunk.rawValue === 'string'
  ) {
    return chunk.rawValue
  }
  if (chunk && typeof chunk === 'object' && 'error' in chunk) {
    return JSON.stringify({ error: chunk.error })
  }
  return undefined
}

function extractSseData(raw: string, maxEvents: number): string[] {
  const dataItems: string[] = []
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (dataItems.length < maxEvents) {
        dataItems.push(event.data)
      }
    },
  })
  parser.feed(raw)
  if (dataItems.length === 0) {
    return [raw.trim()].filter(Boolean)
  }
  return dataItems
}

function extractError(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || !('error' in value)) {
    return undefined
  }
  return value.error && typeof value.error === 'object'
    ? (value.error as Record<string, unknown>)
    : undefined
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 128) : null
}
