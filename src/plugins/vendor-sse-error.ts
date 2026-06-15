import type { ProxyPlugin, PluginContext, PluginResponse } from './types.js'
import { registerBuiltInPlugin } from './loader.js'

export interface VendorSseErrorConfig {
  maxPreviewEvents?: number
  maxPreviewBytes?: number
  rateLimitCodes?: string[]
}

export interface VendorSseErrorResponse {
  status: number
  body: unknown
}

export function inspectVendorSseError(
  config: VendorSseErrorConfig,
  chunk: unknown,
): VendorSseErrorResponse | undefined {
  const raw = extractRaw(chunk)
  if (!raw) {
    return undefined
  }

  const preview = raw.slice(0, config.maxPreviewBytes ?? 65536)
  const dataItems = extractSseData(preview).slice(0, config.maxPreviewEvents ?? 3)
  const codes = config.rateLimitCodes ?? ['rate_limit', 'too_many_requests', 'rate_limit_error']

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
    if (!codes.includes(code ?? '') && !codes.includes(type ?? '')) {
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

const vendorSseErrorPlugin: ProxyPlugin = {
  name: 'vendor_sse_error',

  inspectStreamChunk(ctx: PluginContext & { chunk: unknown }): Promise<void | PluginResponse> {
    const config = ctx.config as VendorSseErrorConfig
    const result = inspectVendorSseError(config, ctx.chunk)
    if (result) {
      return Promise.resolve(result)
    }
    return Promise.resolve()
  },
}

registerBuiltInPlugin(vendorSseErrorPlugin)

// ─── Internal helpers ────────────────────────────────────────────

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

function extractSseData(raw: string): string[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.startsWith('data:'))
  if (lines.length === 0) {
    return [raw.trim()].filter(Boolean)
  }
  return lines.map((line) => line.slice(5).trim()).filter(Boolean)
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
