import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createApp, type ModelGateway } from '../../src/server/app.js'
import type { Settings } from '../../src/index.js'
import {
  loadEnvironmentFiles,
  resolveSettingsPath,
  inspectVendorSseError,
} from '../../src/index.js'
import { redact, safeProxyHost } from '../../src/server/logging.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { makeSettings } from '../helpers/settings.js'
import { stubRegistry } from '../helpers/registry.js'

describe('logging redaction', () => {
  it('redacts known secret fields recursively', () => {
    expect(
      redact({
        apiKey: 'secret',
        'x-api-key': 'secret',
        'proxy-authorization': 'Basic secret',
        nested: { authorization: 'Bearer token', 'api-key': 'secret', api_key: 'secret' },
        ok: 'value',
      }),
    ).toEqual({
      apiKey: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'proxy-authorization': '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
        'api-key': '[REDACTED]',
        api_key: '[REDACTED]',
      },
      ok: 'value',
    })
  })

  it('logs only proxy host', () => {
    expect(safeProxyHost('http://user:pass@127.0.0.1:7890')).toBe('127.0.0.1:7890')
  })
})

describe('request id', () => {
  it('adds x-request-id to responses', async () => {
    const app = createApp({ settings: testSettings, providerRegistry: stubRegistry })

    const response = await app.request('/health')

    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('vendor_sse_error', () => {
  it('converts provider stream rate-limit errors to a safe 429 response', () => {
    const result = inspectVendorSseError(
      { maxPreviewEvents: 3, maxPreviewBytes: 65536, rateLimitCodes: ['rate_limit'] },
      {
        type: 'raw',
        rawValue:
          'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
      },
    )

    expect(result).toEqual({
      status: 429,
      body: {
        error: {
          message: 'Rate limited by upstream provider',
          code: 'rate_limit',
          type: 'rate_limit_error',
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('secret text')
  })

  it('parses multi-line SSE data events', () => {
    const result = inspectVendorSseError(
      { maxPreviewEvents: 3, maxPreviewBytes: 65536, rateLimitCodes: ['rate_limit'] },
      {
        rawValue:
          'data: {"error":{"message":"secret text",\n' +
          'data: "code":"rate_limit","type":"rate_limit_error"}}\n\n',
      },
    )

    expect(result?.status).toBe(429)
    expect(JSON.stringify(result)).not.toContain('secret text')
  })

  it('ignores SSE comments before rate-limit events', () => {
    const result = inspectVendorSseError(
      { maxPreviewEvents: 3, maxPreviewBytes: 65536, rateLimitCodes: ['rate_limit'] },
      {
        rawValue:
          ': keepalive\n' +
          'event: message\n' +
          'data: {"error":{"code":"rate_limit","type":"rate_limit_error"}}\n\n',
      },
    )

    expect(result).toMatchObject({ status: 429 })
  })

  it('preserves raw JSON fallback when the chunk is not SSE', () => {
    const result = inspectVendorSseError(
      { maxPreviewEvents: 3, maxPreviewBytes: 65536, rateLimitCodes: ['rate_limit'] },
      '{"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}',
    )

    expect(result).toMatchObject({ status: 429 })
    expect(JSON.stringify(result)).not.toContain('secret text')
  })

  it('ignores malformed event data without throwing', () => {
    expect(() =>
      inspectVendorSseError(
        { maxPreviewEvents: 3, maxPreviewBytes: 65536, rateLimitCodes: ['rate_limit'] },
        'data: {"error":\n\n',
      ),
    ).not.toThrow()
  })

  it('normalizes invalid preview limits to safe defaults', () => {
    const rateLimitChunk = {
      rawValue:
        'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
    }

    expect(
      inspectVendorSseError(
        {
          maxPreviewEvents: 0,
          maxPreviewBytes: Number.POSITIVE_INFINITY,
          rateLimitCodes: ['rate_limit'],
        },
        rateLimitChunk,
      ),
    ).toMatchObject({ status: 429 })
  })

  it('honors explicit non-matching rate-limit code lists', () => {
    const result = inspectVendorSseError(
      { maxPreviewEvents: 3, maxPreviewBytes: 65536, rateLimitCodes: ['quota_exceeded'] },
      {
        rawValue:
          'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
      },
    )

    expect(result).toBeUndefined()
  })

  it('does not call the gateway when a stream error is detected before sending headers', async () => {
    let calls = 0
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        calls += 1
        return streamError() as AsyncIterable<ProxyStreamPart>
      },
    }
    const app = createApp({ settings: testSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(calls).toBe(1)
    expect(response.status).toBe(429)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    await expect(response.json()).resolves.toEqual({
      error: {
        message: 'Rate limited by upstream provider',
        code: 'rate_limit',
        type: 'rate_limit_error',
      },
    })
  })

  it('emits a safe SSE error chunk when a later stream chunk contains a vendor error', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        return streamLateError() as AsyncIterable<ProxyStreamPart>
      },
    }
    const app = createApp({ settings: testSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('"content":"hello"')
    expect(body).toContain(
      '"error":{"message":"Rate limited by upstream provider","code":"rate_limit","type":"rate_limit_error"}',
    )
    expect(body).not.toContain('secret text')
  })
})

describe('server settings path', () => {
  it('resolves the default settings file from the rootDir', () => {
    const rootDir = join(tmpdir(), 'test-app')
    const result = resolveSettingsPath({ rootDir })

    expect(result).toBe(resolve(rootDir, 'config/settings.jsonc'))
  })

  it('uses LLM_PROXY_SETTINGS_FILE before the default path', () => {
    const rootDir = join(tmpdir(), 'test-app')
    const cwd = join(tmpdir(), 'cwd')
    const result = resolveSettingsPath({
      cwd,
      rootDir,
      envSettingsFile: 'custom/settings.jsonc',
    })

    expect(result).toBe(resolve(cwd, 'custom/settings.jsonc'))
  })
})

describe('environment file loading', () => {
  it('loads root env files with .local overriding .env', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-env-'))
    const keys = ['ROOT_ONLY', 'SHARED_VALUE', 'LOCAL_VALUE']

    await writeFile(
      join(rootDir, '.env'),
      'ROOT_ONLY=root\nSHARED_VALUE=root\nLOCAL_VALUE=root-env\n',
    )
    await writeFile(
      join(rootDir, '.env.local'),
      'SHARED_VALUE=root-local\nLOCAL_VALUE=root-local\n',
    )

    try {
      for (const key of keys) {
        delete process.env[key]
      }

      loadEnvironmentFiles({ rootDir })

      expect(process.env.ROOT_ONLY).toBe('root')
      expect(process.env.LOCAL_VALUE).toBe('root-local')
      expect(process.env.SHARED_VALUE).toBe('root-local')
    } finally {
      for (const key of keys) {
        delete process.env[key]
      }
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

const testSettings = makeSettings({
  openrouter: {
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [{ name: 'vendor_sse_error', config: { rateLimitCodes: ['rate_limit'] } }],
    models: { chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] } },
  },
})

async function* streamError(): AsyncIterable<unknown> {
  yield {
    type: 'raw',
    rawValue:
      'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
  }
}

async function* streamLateError(): AsyncIterable<unknown> {
  yield { type: 'text-delta', text: 'hello' }
  yield {
    type: 'raw',
    rawValue:
      'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
  }
}
