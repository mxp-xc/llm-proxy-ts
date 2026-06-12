import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createApp, type ModelGateway } from '../src/app.js'
import type { Settings, ProviderRegistry } from '@llm-proxy/core'
import { loadEnvironmentFiles, resolveSettingsPath } from '@llm-proxy/core'
import { redact, safeProxyHost } from '../src/logging.js'
import { inspectVendorSseError } from '@llm-proxy/core'

const stubRegistry: ProviderRegistry = {
  languageModel() {
    return { model: {} as never }
  },
  debugProviderConfig() {
    return {} as never
  },
}

describe('logging redaction', () => {
  it('redacts known secret fields recursively', () => {
    expect(
      redact({ apiKey: 'secret', nested: { authorization: 'Bearer token' }, ok: 'value' }),
    ).toEqual({
      apiKey: '[REDACTED]',
      nested: { authorization: '[REDACTED]' },
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

  it('does not call the gateway when a stream error is detected before sending headers', async () => {
    let calls = 0
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        calls += 1
        return streamError()
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
        return streamLateError()
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
  it('loads root and app env files with local files overriding earlier values', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-env-'))
    const appDir = join(rootDir, 'apps', 'server')
    const keys = ['ROOT_ONLY', 'APP_ONLY', 'SHARED_VALUE', 'LOCAL_VALUE']

    await mkdir(appDir, { recursive: true })
    await writeFile(
      join(rootDir, '.env'),
      'ROOT_ONLY=root\nSHARED_VALUE=root\nLOCAL_VALUE=root-env\n',
    )
    await writeFile(
      join(rootDir, '.env.local'),
      'SHARED_VALUE=root-local\nLOCAL_VALUE=root-local\n',
    )
    await writeFile(join(appDir, '.env'), 'APP_ONLY=app\nSHARED_VALUE=app\n')
    await writeFile(join(appDir, '.env.local'), 'SHARED_VALUE=app-local\n')

    try {
      for (const key of keys) {
        delete process.env[key]
      }

      loadEnvironmentFiles({ rootDir, appDir })

      expect(process.env.ROOT_ONLY).toBe('root')
      expect(process.env.APP_ONLY).toBe('app')
      expect(process.env.LOCAL_VALUE).toBe('root-local')
      expect(process.env.SHARED_VALUE).toBe('app-local')
    } finally {
      for (const key of keys) {
        delete process.env[key]
      }
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

const testSettings: Settings = {
  service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
  requestTimeoutMs: 30000,
  proxy: null,
  routing: { enableFlatModelLookup: false },
  plugins: [],
  providers: {
    openrouter: {
      type: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'secret',
      headers: {},
      plugins: [
        { name: 'vendor_sse_error', config: { rateLimitCodes: ['rate_limit'] }, providers: [] },
      ],
      models: { chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] } },
    },
  },
}

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
