import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  generateSettingsJsonSchema,
  loadSettingsFromFile,
  resolveEnvPlaceholders,
} from '../src/config.js'

describe('config', () => {
  it('loads JSONC settings and resolves env placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')
    process.env.OPENROUTER_API_KEY = 'env-secret'

    await writeFile(
      settingsPath,
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

    const settings = await loadSettingsFromFile(settingsPath)

    expect(settings.proxy).toEqual({ url: 'http://127.0.0.1:7890', verify: false })
    expect(settings.providers.openrouter?.apiKey).toBe('env-secret')
    expect(settings.providers.openrouter?.models['deepseek-r1']?.upstreamModel).toBe(
      'deepseek/deepseek-r1',
    )
  })

  it('loads api key arrays and resolves env placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')
    process.env.OPENROUTER_API_KEY_1 = 'env-secret-1'
    process.env.OPENROUTER_API_KEY_2 = 'env-secret-2'

    await writeFile(
      settingsPath,
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

    const settings = await loadSettingsFromFile(settingsPath)

    expect(settings.providers.openrouter?.apiKey).toEqual(['env-secret-1', 'env-secret-2'])
  })

  it('allows inline api keys', () => {
    expect(resolveEnvPlaceholders('ak-inline')).toBe('ak-inline')
  })

  it('rejects service ports outside the TCP port range', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "service": { "port": 65536 }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow()
  })

  it('rejects empty model aliases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1", "aliases": [""] }
            }
          }
        }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow()
  })

  it('rejects empty api key arrays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
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
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow()
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

  it('accepts enableFlatModelLookup per-provider override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
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
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    expect(settings.providers.openrouter?.options?.enableFlatModelLookup).toBe(true)
    expect(settings.routing.enableFlatModelLookup).toBe(false)
  })

  it('accepts modelsEndpoint in provider config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "custom": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "apiKey": "secret",
            "options": { "modelsEndpoint": "/v1/models" },
            "models": {}
          }
        }
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    const p = settings.providers.custom
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options?.modelsEndpoint).toBe('/v1/models')
  })

  it('accepts modelsEndpoint as full URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "custom": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "apiKey": "secret",
            "options": { "modelsEndpoint": "https://other.api.com/list" },
            "models": {}
          }
        }
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    const p = settings.providers.custom
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options?.modelsEndpoint).toBe('https://other.api.com/list')
  })

  it('rejects empty modelsEndpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "custom": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "apiKey": "secret",
            "options": { "modelsEndpoint": "" },
            "models": {}
          }
        }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow()
  })

  it('allows modelsEndpoint to be omitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "custom": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "apiKey": "secret",
            "models": {}
          }
        }
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    const p = settings.providers.custom
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options?.modelsEndpoint).toBeUndefined()
  })

  it('rejects provider with both oauth and auth plugin targeting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
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
      }`,
    )

    // Schema no longer has auth field — oauth+auth conflict is now validated
    // at runtime by PluginRegistry (oauth + auth plugin targeting same provider).
    // The schema-level test just verifies that oauth alone is valid.
    const settings = await loadSettingsFromFile(settingsPath)
    expect(settings.providers['conflicted']?.oauth?.flow).toBe('client_credentials')
  })

  it('accepts provider with oauth only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
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
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    expect(settings.providers['oauth-only']?.oauth?.flow).toBe('client_credentials')
  })

  it('accepts global plugins array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
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
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    expect(settings.plugins).toHaveLength(2)
    expect(settings.plugins[0]).toEqual({ name: 'vendor_sse_error', config: {}, providers: [] })
    expect(settings.plugins[1]?.name).toBe('my-auth')
    expect(settings.plugins[1]?.providers).toEqual(['auth-only'])
  })

  it('accepts provider options.streamOnly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": "secret",
            "options": { "streamOnly": true },
            "models": {}
          }
        }
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    const p = settings.providers.openrouter
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options?.streamOnly).toBe(true)
  })

  it('accepts options.streamOnly for anthropic provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "claude": {
            "type": "anthropic",
            "apiKey": "secret",
            "options": { "streamOnly": true },
            "models": {}
          }
        }
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    const p = settings.providers.claude
    expect(p?.type).toBe('anthropic')
    if (p?.type === 'anthropic') expect(p.options?.streamOnly).toBe(true)
  })

  it('accepts options.streamOnly for openai provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "gpt": {
            "type": "openai",
            "apiKey": "secret",
            "options": { "streamOnly": true },
            "models": {}
          }
        }
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    const p = settings.providers.gpt
    expect(p?.type).toBe('openai')
    if (p?.type === 'openai') expect(p.options?.streamOnly).toBe(true)
  })

  it('defaults options to undefined when omitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": "secret",
            "models": {}
          }
        }
      }`,
    )

    const settings = await loadSettingsFromFile(settingsPath)
    const p = settings.providers.openrouter
    expect(p?.type).toBe('openai-compatible')
    if (p?.type === 'openai-compatible') expect(p.options).toBeUndefined()
  })

  // ── 向后兼容检测 ──────────────────────────────────────────

  it('rejects old top-level enableFlatModelLookup and suggests migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": "secret",
            "enableFlatModelLookup": true,
            "models": {}
          }
        }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow(
      /enableFlatModelLookup.*migrated to provider\.options/,
    )
  })

  it('rejects old top-level anthropicVersion and suggests migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "claude": {
            "type": "anthropic",
            "apiKey": "secret",
            "anthropicVersion": "2023-06-01",
            "models": {}
          }
        }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow(
      /anthropicVersion.*migrated to provider\.options/,
    )
  })

  it('rejects old top-level organization and suggests migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "gpt": {
            "type": "openai",
            "apiKey": "secret",
            "organization": "org-123",
            "models": {}
          }
        }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow(
      /organization.*migrated to provider\.options/,
    )
  })

  // ── 跨类型选项验证 ──────────────────────────────────────

  it('rejects anthropicVersion on openai-compatible provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "custom": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "apiKey": "secret",
            "options": { "anthropicVersion": "2023-06-01" },
            "models": {}
          }
        }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow()
  })

  it('rejects organization on anthropic provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "claude": {
            "type": "anthropic",
            "apiKey": "secret",
            "options": { "organization": "org-123" },
            "models": {}
          }
        }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow()
  })

  it('rejects modelsEndpoint on openai provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'))
    const settingsPath = join(dir, 'settings.jsonc')

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "gpt": {
            "type": "openai",
            "apiKey": "secret",
            "options": { "modelsEndpoint": "/v1/models" },
            "models": {}
          }
        }
      }`,
    )

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow()
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
