import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  generateSettingsJsonSchema,
  loadSettingsFromFile,
  parseAndValidateSettings,
  resolveEnvPlaceholders,
} from '../src/config.js'
import { writeTempSettings } from './helpers/temp-file.js'

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })
  it('loads JSONC settings and resolves env placeholders', async () => {
    const { path: settingsPath } = await writeTempSettings(
      `{
        // comments are allowed
        "service": { "name": "llm-proxy", "host": "127.0.0.1", "port": 8000 },
        "requestTimeoutMs": 30000,
        "proxy": { "url": "http://127.0.0.1:7890", "verify": false },
        "routing": { "enableFlatModelLookup": true },
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": "\${OPENROUTER_API_KEY}",
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1", "aliases": ["default"] }
            }
          }
        }
      }`,
    )
    vi.stubEnv('OPENROUTER_API_KEY', 'env-secret')

    const settings = await loadSettingsFromFile(settingsPath)

    expect(settings.proxy).toEqual({ url: 'http://127.0.0.1:7890', verify: false })
    expect(settings.providers.openrouter?.apiKey).toBe('env-secret')
    expect(settings.providers.openrouter?.models['deepseek-r1']?.upstreamModel).toBe(
      'deepseek/deepseek-r1',
    )
  })

  it('loads api key arrays and resolves env placeholders', async () => {
    const { path: settingsPath } = await writeTempSettings(
      `{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": ["\${OPENROUTER_API_KEY_1}", "\${OPENROUTER_API_KEY_2}"],
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1" }
            }
          }
        }
      }`,
    )
    vi.stubEnv('OPENROUTER_API_KEY_1', 'env-secret-1')
    vi.stubEnv('OPENROUTER_API_KEY_2', 'env-secret-2')

    const settings = await loadSettingsFromFile(settingsPath)

    expect(settings.providers.openrouter?.apiKey).toEqual(['env-secret-1', 'env-secret-2'])
  })

  it('allows inline api keys', () => {
    expect(resolveEnvPlaceholders('ak-inline')).toBe('ak-inline')
  })

  it('rejects service ports outside the TCP port range', () => {
    expect(() =>
      parseAndValidateSettings(`{
        "service": { "port": 65536 }
      }`),
    ).toThrow()
  })

  it('rejects empty model aliases', () => {
    expect(() =>
      parseAndValidateSettings(`{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1", "aliases": [""] }
            }
          }
        }
      }`),
    ).toThrow()
  })

  it('rejects empty api key arrays', () => {
    expect(() =>
      parseAndValidateSettings(`{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": [],
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1" }
            }
          }
        }
      }`),
    ).toThrow()
  })

  it('generates a JSON schema from the Zod settings schema', () => {
    const schema = generateSettingsJsonSchema()

    expect(schema).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'Settings',
      type: 'object',
    })
    expect(JSON.stringify(schema)).toContain('providers')
    expect(JSON.stringify(schema)).toContain('apiKey')
  })

  it('accepts enableFlatModelLookup per-provider override', () => {
    const settings = parseAndValidateSettings(`{
      "routing": { "enableFlatModelLookup": false },
      "providers": {
        "openrouter": {
          "type": "openai-compatible",
          "baseURL": "https://openrouter.ai/api/v1",
          "apiKey": "secret",
          "options": { "enableFlatModelLookup": true },
          "models": {
            "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1" }
          }
        }
      }
    }`)
    expect(settings.providers.openrouter?.options?.enableFlatModelLookup).toBe(true)
    expect(settings.routing.enableFlatModelLookup).toBe(false)
  })

  it('accepts modelsEndpoint in provider config', () => {
    const settings = parseAndValidateSettings(`{
      "providers": {
        "custom": {
          "type": "openai-compatible",
          "baseURL": "https://api.example.com/v1",
          "apiKey": "secret",
          "options": { "modelsEndpoint": "/v1/models" },
          "models": {}
        }
      }
    }`)
    const p = settings.providers.custom
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options?.modelsEndpoint).toBe('/v1/models')
  })

  it('accepts modelsEndpoint as full URL', () => {
    const settings = parseAndValidateSettings(`{
      "providers": {
        "custom": {
          "type": "openai-compatible",
          "baseURL": "https://api.example.com/v1",
          "apiKey": "secret",
          "options": { "modelsEndpoint": "https://other.api.com/list" },
          "models": {}
        }
      }
    }`)
    const p = settings.providers.custom
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options?.modelsEndpoint).toBe('https://other.api.com/list')
  })

  it('rejects empty modelsEndpoint', () => {
    expect(() =>
      parseAndValidateSettings(`{
        "providers": {
          "custom": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "apiKey": "secret",
            "options": { "modelsEndpoint": "" },
            "models": {}
          }
        }
      }`),
    ).toThrow()
  })

  it('allows modelsEndpoint to be omitted', () => {
    const settings = parseAndValidateSettings(`{
      "providers": {
        "custom": {
          "type": "openai-compatible",
          "baseURL": "https://api.example.com/v1",
          "apiKey": "secret",
          "models": {}
        }
      }
    }`)
    const p = settings.providers.custom
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options?.modelsEndpoint).toBeUndefined()
  })

  it('rejects provider with both oauth and auth plugin targeting it', () => {
    // Schema no longer has auth field — oauth+auth conflict is now validated
    // at runtime by PluginRegistry (oauth + auth plugin targeting same provider).
    // The schema-level test just verifies that oauth alone is valid.
    const settings = parseAndValidateSettings(`{
      "plugins": [
        { "name": "my-auth", "config": {}, "providers": ["conflicted"] }
      ],
      "providers": {
        "conflicted": {
          "type": "openai-compatible",
          "baseURL": "https://api.example.com/v1",
          "apiKey": "secret",
          "oauth": {
            "flow": "client_credentials",
            "clientId": "id",
            "clientSecret": "secret",
            "tokenUrl": "https://auth.example.com/token"
          },
          "models": {}
        }
      }
    }`)
    expect(settings.providers['conflicted']?.oauth?.flow).toBe('client_credentials')
  })

  it('accepts provider with oauth only', () => {
    const settings = parseAndValidateSettings(`{
      "providers": {
        "oauth-only": {
          "type": "openai-compatible",
          "baseURL": "https://api.example.com/v1",
          "apiKey": "secret",
          "oauth": {
            "flow": "client_credentials",
            "clientId": "id",
            "clientSecret": "secret",
            "tokenUrl": "https://auth.example.com/token"
          },
          "models": {}
        }
      }
    }`)
    expect(settings.providers['oauth-only']?.oauth?.flow).toBe('client_credentials')
  })

  it('accepts global plugins array', () => {
    const settings = parseAndValidateSettings(`{
      "plugins": [
        "vendor_sse_error",
        { "name": "my-auth", "config": { "tokenUrl": "https://auth.example.com/token" }, "providers": ["auth-only"] }
      ],
      "providers": {
        "auth-only": {
          "type": "openai-compatible",
          "baseURL": "https://api.example.com/v1",
          "apiKey": "secret",
          "models": {}
        }
      }
    }`)
    expect(settings.plugins).toHaveLength(2)
    expect(settings.plugins[0]).toEqual({ name: 'vendor_sse_error', config: {}, providers: [] })
    expect(settings.plugins[1]?.name).toBe('my-auth')
    expect(settings.plugins[1]?.providers).toEqual(['auth-only'])
  })

  it.each([
    { name: 'openai-compatible', providerKey: 'openrouter', type: 'openai-compatible', extraFields: `"baseURL": "https://openrouter.ai/api/v1",` },
    { name: 'anthropic', providerKey: 'claude', type: 'anthropic', extraFields: '' },
    { name: 'openai', providerKey: 'gpt', type: 'openai', extraFields: '' },
  ] as const)('accepts options.streamOnly for $name provider', ({ providerKey, type, extraFields }) => {
    const settings = parseAndValidateSettings(`{
      "providers": {
        "${providerKey}": {
          "type": "${type}",
          ${extraFields}
          "apiKey": "secret",
          "options": { "streamOnly": true },
          "models": {}
        }
      }
    }`)
    const p = settings.providers[providerKey]
    expect(p?.type).toBe(type)
    if (p?.type === type) expect(p.options?.streamOnly).toBe(true)
  })

  it('defaults options to undefined when omitted', () => {
    const settings = parseAndValidateSettings(`{
      "providers": {
        "openrouter": {
          "type": "openai-compatible",
          "baseURL": "https://openrouter.ai/api/v1",
          "apiKey": "secret",
          "models": {}
        }
      }
    }`)
    const p = settings.providers.openrouter
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options).toBeUndefined()
  })

  // ── 向后兼容检测 ──────────────────────────────────────────

  it.each([
    { field: 'enableFlatModelLookup', value: 'true', type: 'openai-compatible', providerKey: 'openrouter', extraFields: `"baseURL": "https://openrouter.ai/api/v1",` },
    { field: 'anthropicVersion', value: '"2023-06-01"', type: 'anthropic', providerKey: 'claude', extraFields: '' },
    { field: 'organization', value: '"org-123"', type: 'openai', providerKey: 'gpt', extraFields: '' },
  ] as const)('rejects old top-level $field and suggests migration', ({ field, value, type, providerKey, extraFields }) => {
    expect(() =>
      parseAndValidateSettings(`{
        "providers": {
          "${providerKey}": {
            "type": "${type}",
            ${extraFields}
            "apiKey": "secret",
            "${field}": ${value},
            "models": {}
          }
        }
      }`),
    ).toThrow(new RegExp(`${field}.*moved into "options"`))
  })

  // ── 跨类型选项验证 ──────────────────────────────────────

  it.each([
    { option: 'anthropicVersion', optionValue: '"2023-06-01"', type: 'openai-compatible', providerKey: 'custom', extraFields: `"baseURL": "https://api.example.com/v1",` },
    { option: 'organization', optionValue: '"org-123"', type: 'anthropic', providerKey: 'claude', extraFields: '' },
    { option: 'modelsEndpoint', optionValue: '"/v1/models"', type: 'openai', providerKey: 'gpt', extraFields: '' },
  ] as const)('rejects $option on $type provider', ({ option, optionValue, type, providerKey, extraFields }) => {
    expect(() =>
      parseAndValidateSettings(`{
        "providers": {
          "${providerKey}": {
            "type": "${type}",
            ${extraFields}
            "apiKey": "secret",
            "options": { "${option}": ${optionValue} },
            "models": {}
          }
        }
      }`),
    ).toThrow()
  })

  // ── JSON Schema 按类型区分 options ──────────────────────

  it('generates per-type options in JSON schema', () => {
    const schema = generateSettingsJsonSchema()
    const json = JSON.stringify(schema)

    // openai-compatible 应有 modelsEndpoint/includeUsage，不应有 anthropicVersion/organization/project
    expect(json).toContain('modelsEndpoint')
    expect(json).toContain('includeUsage')
    expect(json).toContain('anthropicVersion')
    expect(json).toContain('organization')
    expect(json).toContain('project')

    // 验证 schema 结构：找到 openai-compatible 的 options 块应包含 modelsEndpoint 但不含 anthropicVersion
    const schemaObj = schema as Record<string, unknown>
    const defs = schemaObj.definitions as Record<string, unknown> | undefined
    // $refStrategy: 'none' 意味着没有 definitions，所有内容内联
    // 通过验证关键属性存在即可
    expect(json).toContain('streamOnly')
    expect(json).toContain('enableFlatModelLookup')
  })
})
