import { describe, expect, it, vi } from 'vitest'
import {
  fetchUpstreamModels,
  openAIToDiscoveredModels,
  resolveModelsUrl,
} from '../../src/cli/discover-models.js'

describe('resolveModelsUrl', () => {
  it('defaults to {baseURL}/models when modelsEndpoint is absent', () => {
    expect(resolveModelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models')
  })

  it('strips trailing slashes from baseURL', () => {
    expect(resolveModelsUrl('https://api.example.com/v1///')).toBe(
      'https://api.example.com/v1/models',
    )
  })

  it('uses full URL when modelsEndpoint starts with http(s)://', () => {
    expect(resolveModelsUrl('https://api.example.com/v1', 'https://other.api.com/list')).toBe(
      'https://other.api.com/list',
    )
    expect(resolveModelsUrl('https://api.example.com/v1', 'http://localhost:9090/models')).toBe(
      'http://localhost:9090/models',
    )
  })

  it('appends relative path to baseURL when modelsEndpoint does not start with http', () => {
    expect(resolveModelsUrl('https://api.example.com/v1', '/v1/models')).toBe(
      'https://api.example.com/v1/v1/models',
    )
    expect(resolveModelsUrl('https://api.example.com', 'api/list')).toBe(
      'https://api.example.com/api/list',
    )
  })
})

describe('fetchUpstreamModels', () => {
  const mockModelList = {
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
      { id: 'claude-3-opus', object: 'model', owned_by: 'anthropic' },
      { id: 'deepseek-r1', object: 'model', owned_by: 'deepseek' },
    ],
  }

  it('fetches and sorts models from upstream', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    const models = await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
    })

    expect(models).toHaveLength(3)
    expect(models[0]?.id).toBe('claude-3-opus')
    expect(models[1]?.id).toBe('deepseek-r1')
    expect(models[2]?.id).toBe('gpt-4o')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    )

    vi.restoreAllMocks()
  })

  it('uses first API key from array', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: ['key-1', 'key-2'],
      proxySettings: null,
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer key-1' }),
      }),
    )

    vi.restoreAllMocks()
  })

  it('sends request without auth when apiKey is null', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: null,
      proxySettings: null,
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {},
      }),
    )

    vi.restoreAllMocks()
  })

  it('strips trailing slashes from baseURL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1///',
      apiKey: 'test-key',
      proxySettings: null,
    })

    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/v1/models', expect.any(Object))

    vi.restoreAllMocks()
  })

  it('throws on non-200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      fetchUpstreamModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'bad-key',
        proxySettings: null,
      }),
    ).rejects.toThrow('HTTP 401 Unauthorized')

    vi.restoreAllMocks()
  })

  it('throws on unexpected response format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ object: 'list', data: null }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      fetchUpstreamModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test-key',
        proxySettings: null,
      }),
    ).rejects.toThrow('Unexpected response format')

    vi.restoreAllMocks()
  })

  it('uses proxy fetch when proxySettings is provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    const models = await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
    })

    expect(models).toHaveLength(3)
    expect(mockFetch).toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  it('uses custom modelsEndpoint as relative path', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
      modelsEndpoint: '/v1/models',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/v1/models',
      expect.any(Object),
    )

    vi.restoreAllMocks()
  })

  it('uses custom modelsEndpoint as full URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
      modelsEndpoint: 'https://other.api.com/list',
    })

    expect(mockFetch).toHaveBeenCalledWith('https://other.api.com/list', expect.any(Object))

    vi.restoreAllMocks()
  })

  it('includes provider headers in request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
      headers: { 'X-Custom': 'value', 'X-Another': 'header' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom': 'value',
          'X-Another': 'header',
          Authorization: 'Bearer test-key',
        }),
      }),
    )

    vi.restoreAllMocks()
  })

  it('oauthToken takes priority over apiKey for Authorization', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
      oauthToken: { tokenType: 'Bearer', accessToken: 'oauth-access-token' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
        }),
      }),
    )

    vi.restoreAllMocks()
  })

  it('oauthToken with non-Bearer tokenType', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: null,
      proxySettings: null,
      oauthToken: { tokenType: 'MAC', accessToken: 'mac-token' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'MAC mac-token',
        }),
      }),
    )

    vi.restoreAllMocks()
  })

  it('oauthToken overrides Authorization from static headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: null,
      proxySettings: null,
      headers: { Authorization: 'Basic static-auth', 'X-Custom': 'value' },
      oauthToken: { tokenType: 'Bearer', accessToken: 'oauth-token' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
          'X-Custom': 'value',
        }),
      }),
    )

    vi.restoreAllMocks()
  })

  it('apiKey overrides Authorization from static headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
      headers: { Authorization: 'Basic static-auth' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    )

    vi.restoreAllMocks()
  })
})

describe('openAIToDiscoveredModels', () => {
  it('converts OpenAIModel[] to DiscoveredModelList', () => {
    const openaiModels = [
      { id: 'gpt-4o', object: 'model', created: 123, owned_by: 'openai' },
      { id: 'claude-3-opus', object: 'model', owned_by: 'anthropic' },
    ]
    const result = openAIToDiscoveredModels(openaiModels)
    expect(result).toEqual({
      models: [{ id: 'gpt-4o' }, { id: 'claude-3-opus' }],
    })
  })

  it('handles empty model list', () => {
    const result = openAIToDiscoveredModels([])
    expect(result).toEqual({ models: [] })
  })

  it('discards OpenAI-specific fields', () => {
    const openaiModels = [{ id: 'model-a', object: 'model', created: 999, owned_by: 'org' }]
    const result = openAIToDiscoveredModels(openaiModels)
    expect(result.models[0]).toEqual({ id: 'model-a' })
  })
})
