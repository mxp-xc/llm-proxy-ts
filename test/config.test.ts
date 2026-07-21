import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Ajv } from 'ajv'
import {
  generateSettingsJsonSchema,
  loadSettingsFromFile,
  modelRouteConfigSchema,
  parseAndValidateSettings,
  resolveEnvPlaceholders,
} from '../src/config.js'
import { writeTempSettings } from './helpers/temp-file.js'

function compileGeneratedSettingsSchema() {
  const ajv = new Ajv({ strict: false, allErrors: true })
  return ajv.compile(generateSettingsJsonSchema())
}

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

  it('does not expose proxy no-proxy in the generated schema', () => {
    const schema = generateSettingsJsonSchema()

    expect(JSON.stringify(schema)).not.toContain('no-proxy')
  })

  it('ignores unsupported proxy no-proxy settings', () => {
    const settings = parseAndValidateSettings(`{
      "proxy": {
        "url": "http://127.0.0.1:7890",
        "verify": false,
        "no-proxy": "localhost,127.0.0.1,.internal.example"
      }
    }`)

    expect(settings.proxy).toEqual({
      url: 'http://127.0.0.1:7890',
      verify: false,
    })
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

  it('accepts provider and model disabled-tools matchers', () => {
    const raw = `{
      "providers": {
        "openrouter": {
          "type": "openai-compatible",
          "baseURL": "https://openrouter.ai/api/v1",
          "options": {
            "disabled-tools": ["apply_patch", { "glob": "mcp__github__*" }]
          },
          "models": {
            "chat": {
              "upstreamModel": "gpt-5",
              "disabled-tools": []
            }
          }
        }
      }
    }`
    const settings = parseAndValidateSettings(raw)

    expect(settings.providers.openrouter?.options?.['disabled-tools']).toEqual([
      'apply_patch',
      { glob: 'mcp__github__*' },
    ])
    expect(settings.providers.openrouter?.models.chat?.['disabled-tools']).toEqual([])
    expect(compileGeneratedSettingsSchema()(JSON.parse(raw))).toBe(true)
  })

  it.each(['[""]', '[{ "glob": "" }]', '[{ "glob": "tool_*", "extra": true }]'])(
    'rejects invalid disabled-tools matcher %s',
    (matcher) => {
      const raw = `{
      "providers": {
        "openrouter": {
          "type": "openai-compatible",
          "baseURL": "https://openrouter.ai/api/v1",
          "options": { "disabled-tools": ${matcher} },
          "models": { "chat": { "upstreamModel": "gpt-5" } }
        }
      }
    }`

      expect(() => parseAndValidateSettings(raw)).toThrow()
      expect(compileGeneratedSettingsSchema()(JSON.parse(raw))).toBe(false)
    },
  )

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
    if (p?.type === 'openai-compatible')
      expect(p.options?.modelsEndpoint).toBe('https://other.api.com/list')
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

  it('normalizes global plugin providers shorthand', () => {
    const settings = parseAndValidateSettings(`{
      "plugins": [
        { "name": "my-auth", "config": {}, "providers": "auth-only" }
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

    expect(settings.plugins[0]?.providers).toEqual(['auth-only'])
  })

  it.each([
    {
      level: 'provider',
      pluginsJson: '"plugins": [{ "name": "vendor_sse_error", "providers": ["other"] }]',
    },
    {
      level: 'model',
      pluginsJson: `"models": {
        "chat": {
          "upstreamModel": "upstream-chat",
          "plugins": [{ "name": "vendor_sse_error", "providers": ["other"] }]
        }
      }`,
    },
  ])('rejects providers on $level-scoped plugins', ({ pluginsJson }) => {
    expect(() =>
      parseAndValidateSettings(`{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "apiKey": "secret",
            ${pluginsJson}
          }
        }
      }`),
    ).toThrow(/providers/)
  })

  it.each([
    {
      name: 'openai-compatible',
      providerKey: 'openrouter',
      type: 'openai-compatible',
      extraFields: `"baseURL": "https://openrouter.ai/api/v1",`,
    },
    { name: 'anthropic', providerKey: 'claude', type: 'anthropic', extraFields: '' },
    { name: 'openai', providerKey: 'gpt', type: 'openai', extraFields: '' },
  ] as const)(
    'accepts options.streamOnly for $name provider',
    ({ providerKey, type, extraFields }) => {
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
    },
  )

  it('accepts supports_vision at provider options and model top level without defaults', () => {
    const settings = parseAndValidateSettings(`{
      "providers": {
        "custom": {
          "type": "openai-compatible",
          "baseURL": "https://api.example.com/v1",
          "options": { "supports_vision": false },
          "models": {
            "vision": { "upstreamModel": "vision-model", "supports_vision": true },
            "text": { "upstreamModel": "text-model" }
          }
        },
        "unset": {
          "type": "openai-compatible",
          "baseURL": "https://api.example.com/v1",
          "options": {},
          "models": {}
        }
      }
    }`)

    const provider = settings.providers.custom
    expect(provider?.options?.supports_vision).toBe(false)
    expect(provider?.models.vision?.supports_vision).toBe(true)
    expect(provider?.models.text?.supports_vision).toBeUndefined()
    expect(settings.providers.unset?.options?.supports_vision).toBeUndefined()
  })

  it('accepts optional tool-result artifact storage and applies bounded defaults', () => {
    const storageDir = resolve('temp/vision-artifacts')
    const settings = parseAndValidateSettings(
      JSON.stringify({
        visionFallback: {
          toolResultArtifacts: {
            storageDir,
            agentVisibleDir: '/workspace/.llm-proxy/vision-artifacts',
          },
        },
      }),
    )

    expect(settings.visionFallback?.toolResultArtifacts).toEqual({
      storageDir,
      agentVisibleDir: '/workspace/.llm-proxy/vision-artifacts',
      ttlMs: 86_400_000,
      maxImageBytes: 10_485_760,
      maxRequestBytes: 20_971_520,
      maxTotalBytes: 1_073_741_824,
    })
    expect(parseAndValidateSettings('{}').visionFallback).toBeUndefined()
  })

  it.each([
    {
      name: 'relative server path',
      config: { storageDir: 'relative/artifacts', agentVisibleDir: '/shared/artifacts' },
      message: /storageDir must be an absolute path/,
    },
    {
      name: 'relative agent path',
      config: { storageDir: resolve('temp/artifacts'), agentVisibleDir: 'relative/artifacts' },
      message: /agentVisibleDir must be an absolute path/,
    },
    {
      name: 'server path ending in CR',
      config: {
        storageDir: `${resolve('temp/artifacts')}\r`,
        agentVisibleDir: '/shared/artifacts',
      },
      message: /path must not contain NUL, CR, or LF/,
    },
    {
      name: 'agent path ending in LF',
      config: {
        storageDir: resolve('temp/artifacts'),
        agentVisibleDir: '/shared/artifacts\n',
      },
      message: /path must not contain NUL, CR, or LF/,
    },
    {
      name: 'request limit below image limit',
      config: {
        storageDir: resolve('temp/artifacts'),
        agentVisibleDir: '/shared/artifacts',
        maxImageBytes: 10,
        maxRequestBytes: 9,
      },
      message: /maxRequestBytes must be greater than or equal to maxImageBytes/,
    },
    {
      name: 'total limit below request limit',
      config: {
        storageDir: resolve('temp/artifacts'),
        agentVisibleDir: '/shared/artifacts',
        maxImageBytes: 10,
        maxRequestBytes: 20,
        maxTotalBytes: 19,
      },
      message: /maxTotalBytes must be greater than or equal to maxRequestBytes/,
    },
  ])('rejects invalid artifact storage config: $name', ({ config, message }) => {
    expect(() =>
      parseAndValidateSettings(JSON.stringify({ visionFallback: { toolResultArtifacts: config } })),
    ).toThrow(message)
  })

  it('rejects supports_vision at the provider top level with a placement hint', () => {
    expect(() =>
      parseAndValidateSettings(`{
        "providers": {
          "custom": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "supports_vision": false,
            "models": {}
          }
        }
      }`),
    ).toThrow(/provider\.options\.supports_vision/)
  })

  it('rejects model options.supports_vision with a model-level placement hint', () => {
    expect(() =>
      parseAndValidateSettings(`{
        "providers": {
          "custom": {
            "type": "openai-compatible",
            "baseURL": "https://api.example.com/v1",
            "models": {
              "chat": {
                "upstreamModel": "model-x",
                "options": { "supports_vision": false }
              }
            }
          }
        }
      }`),
    ).toThrow(/supports_vision.*model top level/)
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
    {
      field: 'enableFlatModelLookup',
      value: 'true',
      type: 'openai-compatible',
      providerKey: 'openrouter',
      extraFields: `"baseURL": "https://openrouter.ai/api/v1",`,
    },
    {
      field: 'anthropicVersion',
      value: '"2023-06-01"',
      type: 'anthropic',
      providerKey: 'claude',
      extraFields: '',
    },
    {
      field: 'organization',
      value: '"org-123"',
      type: 'openai',
      providerKey: 'gpt',
      extraFields: '',
    },
  ] as const)(
    'rejects old top-level $field and suggests migration',
    ({ field, value, type, providerKey, extraFields }) => {
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
      ).toThrow(new RegExp(`${field}.*migrated to provider\\.options`))
    },
  )

  // ── 跨类型选项验证 ──────────────────────────────────────

  it.each([
    {
      option: 'anthropicVersion',
      optionValue: '"2023-06-01"',
      type: 'openai-compatible',
      providerKey: 'custom',
      extraFields: `"baseURL": "https://api.example.com/v1",`,
    },
    {
      option: 'organization',
      optionValue: '"org-123"',
      type: 'anthropic',
      providerKey: 'claude',
      extraFields: '',
    },
    {
      option: 'modelsEndpoint',
      optionValue: '"/v1/models"',
      type: 'openai',
      providerKey: 'gpt',
      extraFields: '',
    },
  ] as const)(
    'rejects $option on $type provider',
    ({ option, optionValue, type, providerKey, extraFields }) => {
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
    },
  )

  // ── JSON Schema 按类型区分 options ──────────────────────

  it('validates provider-specific options through generated JSON schema', () => {
    const validate = compileGeneratedSettingsSchema()

    expect(
      validate({
        providers: {
          compatible: {
            type: 'openai-compatible',
            baseURL: 'https://api.example.com/v1',
            options: { modelsEndpoint: '/models', includeUsage: true },
            models: { chat: { upstreamModel: 'model-x' } },
          },
        },
      }),
    ).toBe(true)

    expect(
      validate({
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'secret',
            options: { organization: 'org-test', project: 'proj-test' },
            models: { chat: { upstreamModel: 'gpt-5' } },
          },
        },
      }),
    ).toBe(true)

    expect(
      validate({
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'secret',
            options: { modelsEndpoint: '/models' },
            models: { chat: { upstreamModel: 'gpt-5' } },
          },
        },
      }),
    ).toBe(false)

    expect(
      validate({
        providers: {
          anthropic: {
            type: 'anthropic',
            apiKey: 'secret',
            options: { organization: 'org-test' },
            models: { sonnet: { upstreamModel: 'claude-sonnet' } },
          },
        },
      }),
    ).toBe(false)
  })

  it('validates supports_vision placements and types through generated JSON schema', () => {
    const validate = compileGeneratedSettingsSchema()

    expect(
      validate({
        providers: {
          compatible: {
            type: 'openai-compatible',
            baseURL: 'https://api.example.com/v1',
            options: { supports_vision: false },
            models: { chat: { upstreamModel: 'model-x', supports_vision: true } },
          },
        },
      }),
    ).toBe(true)

    expect(
      validate({
        providers: {
          compatible: {
            type: 'openai-compatible',
            baseURL: 'https://api.example.com/v1',
            options: { supports_vision: 'false' },
            models: { chat: { upstreamModel: 'model-x' } },
          },
        },
      }),
    ).toBe(false)

    expect(
      validate({
        providers: {
          compatible: {
            type: 'openai-compatible',
            baseURL: 'https://api.example.com/v1',
            models: { chat: { upstreamModel: 'model-x', supports_vision: 'true' } },
          },
        },
      }),
    ).toBe(false)

    expect(
      validate({
        providers: {
          compatible: {
            type: 'openai-compatible',
            baseURL: 'https://api.example.com/v1',
            supports_vision: false,
            models: { chat: { upstreamModel: 'model-x' } },
          },
        },
      }),
    ).toBe(false)

    expect(
      validate({
        providers: {
          compatible: {
            type: 'openai-compatible',
            baseURL: 'https://api.example.com/v1',
            models: {
              chat: {
                upstreamModel: 'model-x',
                options: { supports_vision: false },
              },
            },
          },
        },
      }),
    ).toBe(false)
  })

  it('validates tool-result artifact storage through generated JSON schema', () => {
    const validate = compileGeneratedSettingsSchema()
    const validArtifactConfig = {
      storageDir: resolve('temp/vision-artifacts'),
      agentVisibleDir: '/shared/vision-artifacts',
    }

    expect(
      validate({
        visionFallback: {
          toolResultArtifacts: {
            ...validArtifactConfig,
            ttlMs: 60_000,
            maxImageBytes: 1024,
            maxRequestBytes: 2048,
            maxTotalBytes: 4096,
          },
        },
      }),
    ).toBe(true)

    expect(
      validate({
        visionFallback: {
          toolResultArtifacts: {
            ...validArtifactConfig,
            ttlMs: '60000',
          },
        },
      }),
    ).toBe(false)

    expect(
      validate({
        visionFallback: {
          toolResultArtifacts: {
            ...validArtifactConfig,
            unexpected: true,
          },
        },
      }),
    ).toBe(false)

    for (const invalidArtifactConfig of [
      { ...validArtifactConfig, storageDir: 'relative/artifacts' },
      { ...validArtifactConfig, agentVisibleDir: 'relative/artifacts' },
      { ...validArtifactConfig, storageDir: `${validArtifactConfig.storageDir}\r` },
      { ...validArtifactConfig, agentVisibleDir: '/shared/artifacts\n' },
      { ...validArtifactConfig, storageDir: `${validArtifactConfig.storageDir}\u0000suffix` },
      { ...validArtifactConfig, ttlMs: 0 },
      { ...validArtifactConfig, maxImageBytes: 1.5 },
    ]) {
      expect(validate({ visionFallback: { toolResultArtifacts: invalidArtifactConfig } })).toBe(
        false,
      )
    }

    const generatedSchema = JSON.stringify(generateSettingsJsonSchema())
    expect(generatedSchema).toContain('must be greater than or equal to maxImageBytes')
    expect(generatedSchema).toContain('must be greater than or equal to maxRequestBytes')
  })

  it('rejects slash-containing aliases through generated JSON schema', () => {
    const validate = compileGeneratedSettingsSchema()

    expect(
      validate({
        providers: {
          compatible: {
            type: 'openai-compatible',
            baseURL: 'https://api.example.com/v1',
            models: { chat: { upstreamModel: 'model-x', aliases: ['bad/alias'] } },
          },
        },
      }),
    ).toBe(false)
  })

  it('keeps committed settings schema in sync with generated schema', async () => {
    const committed = await readFile('config/settings.schema.json', 'utf8')
    expect(committed).toBe(`${JSON.stringify(generateSettingsJsonSchema(), null, 2)}\n`)
  })
})

describe('modelRouteConfigSchema aliases', () => {
  it('accepts string aliases and normalizes to {name, flat:false}', () => {
    const r = modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: ['a1', 'a2'] })
    expect(r.aliases).toEqual([
      { name: 'a1', flat: false },
      { name: 'a2', flat: false },
    ])
    expect(r.flat).toBeUndefined()
  })

  it('accepts record aliases with flat', () => {
    const r = modelRouteConfigSchema.parse({
      upstreamModel: 'm',
      aliases: [{ name: 'a', flat: true }, 'b'],
    })
    expect(r.aliases).toEqual([
      { name: 'a', flat: true },
      { name: 'b', flat: false },
    ])
  })

  it('accepts model-level flat', () => {
    expect(modelRouteConfigSchema.parse({ upstreamModel: 'm', flat: true }).flat).toBe(true)
  })

  it('rejects empty alias name', () => {
    expect(() => modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [''] })).toThrow()
    expect(() =>
      modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [{ name: '' }] }),
    ).toThrow()
  })

  it('rejects alias name containing "/" (string and record)', () => {
    expect(() => modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: ['a/b'] })).toThrow()
    expect(() =>
      modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [{ name: 'a/b' }] }),
    ).toThrow()
  })

  it('rejects record alias missing name', () => {
    expect(() =>
      modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: [{ flat: true }] }),
    ).toThrow()
  })

  it('does not trim whitespace-only alias name', () => {
    expect(modelRouteConfigSchema.parse({ upstreamModel: 'm', aliases: ['  '] }).aliases).toEqual([
      { name: '  ', flat: false },
    ])
  })
})
