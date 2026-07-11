import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const proxyFetchMock = vi.hoisted(() => vi.fn())
const createProxyFetchMock = vi.hoisted(() => vi.fn(() => proxyFetchMock))

vi.mock('../../src/providers/shared/provider-factory.js', () => ({
  createProxyFetch: createProxyFetchMock,
}))

import {
  extractLimit,
  fetchUpstreamModels,
  openAIToDiscoveredModels,
  resolveModelsUrl,
} from '../../src/cli/models/discover.js'

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

  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    proxyFetchMock.mockReset()
    proxyFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    createProxyFetchMock.mockClear()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches and sorts models from upstream', async () => {
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
  })

  it('uses first API key from array', async () => {
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
  })

  it('sends request without auth when apiKey is null', async () => {
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
  })

  it('strips trailing slashes from baseURL', async () => {
    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1///',
      apiKey: 'test-key',
      proxySettings: null,
    })

    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/v1/models', expect.any(Object))
  })

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    })

    await expect(
      fetchUpstreamModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'bad-key',
        proxySettings: null,
      }),
    ).rejects.toThrow('HTTP 401 Unauthorized')
  })

  it('throws on unexpected response format', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ object: 'list', data: null }),
    })

    await expect(
      fetchUpstreamModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test-key',
        proxySettings: null,
      }),
    ).rejects.toThrow('Unexpected response format')
  })

  it('uses proxy fetch when proxySettings is provided', async () => {
    const models = await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: { url: 'http://127.0.0.1:7890', verify: false },
    })

    expect(models).toHaveLength(3)
    expect(createProxyFetchMock).toHaveBeenCalledWith('http://127.0.0.1:7890', false)
    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('includes OpenAI organization and project headers when provided', async () => {
    await fetchUpstreamModels({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
      openAIOptions: { organization: 'org-test', project: 'proj-test' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'OpenAI-Organization': 'org-test',
          'OpenAI-Project': 'proj-test',
        }),
      }),
    )
  })

  it('uses custom modelsEndpoint as relative path', async () => {
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
  })

  it('uses custom modelsEndpoint as full URL', async () => {
    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
      modelsEndpoint: 'https://other.api.com/list',
    })

    expect(mockFetch).toHaveBeenCalledWith('https://other.api.com/list', expect.any(Object))
  })

  it('includes provider headers in request', async () => {
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
  })

  it('oauthToken takes priority over apiKey for Authorization', async () => {
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
  })

  it('oauthToken with non-Bearer tokenType', async () => {
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
  })

  it('oauthToken overrides Authorization from static headers', async () => {
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
  })

  it('apiKey overrides Authorization from static headers', async () => {
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
  })
})

describe('fetchUpstreamModels with authMode=anthropic', () => {
  const mockModelList = {
    object: 'list',
    data: [{ id: 'claude-3-5-sonnet', object: 'model', owned_by: 'anthropic' }],
  }

  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses x-api-key and default anthropic-version headers with apiKey', async () => {
    await fetchUpstreamModels({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
      proxySettings: null,
      authMode: 'anthropic',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'anthropic-key',
          'anthropic-version': '2023-06-01',
        }),
      }),
    )
    const callHeaders = (mockFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(callHeaders['Authorization']).toBeUndefined()
  })

  it('uses Authorization Bearer with oauthToken (still sets anthropic-version)', async () => {
    await fetchUpstreamModels({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
      proxySettings: null,
      oauthToken: { tokenType: 'Bearer', accessToken: 'oauth-token' },
      authMode: 'anthropic',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
          'anthropic-version': '2023-06-01',
        }),
      }),
    )
    const callHeaders = (mockFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(callHeaders['x-api-key']).toBeUndefined()
  })

  it('uses custom anthropicVersion when provided', async () => {
    await fetchUpstreamModels({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-key',
      proxySettings: null,
      authMode: 'anthropic',
      anthropicVersion: '2024-10-22',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'anthropic-version': '2024-10-22',
          'x-api-key': 'anthropic-key',
        }),
      }),
    )
  })

  it('follows Anthropic pagination via has_more + last_id', async () => {
    mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            object: 'list',
            data: [{ id: 'm1', object: 'model' }],
            has_more: true,
            last_id: 'm1',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            object: 'list',
            data: [{ id: 'm2', object: 'model' }],
            has_more: false,
            last_id: null,
          }),
      })
    vi.stubGlobal('fetch', mockFetch)

    const models = await fetchUpstreamModels({
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'key',
      proxySettings: null,
      authMode: 'anthropic',
    })

    expect(models.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[1]![0]).toBe('https://api.anthropic.com/v1/models?after_id=m1')
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

  it('discards OpenAI-specific fields when no limit fields present', () => {
    const openaiModels = [{ id: 'model-a', object: 'model', created: 999, owned_by: 'org' }]
    const result = openAIToDiscoveredModels(openaiModels)
    expect(result.models[0]).toEqual({ id: 'model-a' })
  })

  it('extracts limit from upstream extension fields', () => {
    const openaiModels = [
      { id: 'deepseek-r1', object: 'model', context_length: 65536, max_output_tokens: 8192 },
    ]
    const result = openAIToDiscoveredModels(openaiModels)
    expect(result.models[0]).toEqual({
      id: 'deepseek-r1',
      limit: { context: 65536, output: 8192 },
    })
  })

  it('extracts only context_length when max_output_tokens is absent', () => {
    const openaiModels = [{ id: 'model-a', object: 'model', context_length: 128000 }]
    const result = openAIToDiscoveredModels(openaiModels)
    expect(result.models[0]).toEqual({
      id: 'model-a',
      limit: { context: 128000 },
    })
  })

  it('extracts only max_output_tokens when context_length is absent', () => {
    const openaiModels = [{ id: 'model-b', object: 'model', max_output_tokens: 4096 }]
    const result = openAIToDiscoveredModels(openaiModels)
    expect(result.models[0]).toEqual({
      id: 'model-b',
      limit: { output: 4096 },
    })
  })
})

describe('extractLimit', () => {
  it('returns undefined when no limit fields present', () => {
    expect(extractLimit({})).toBeUndefined()
  })

  it('maps context_length to limit.context', () => {
    expect(extractLimit({ context_length: 32000 })).toEqual({ context: 32000 })
  })

  it('maps max_output_tokens to limit.output', () => {
    expect(extractLimit({ max_output_tokens: 4096 })).toEqual({ output: 4096 })
  })

  it('maps both fields when present', () => {
    expect(extractLimit({ context_length: 128000, max_output_tokens: 16384 })).toEqual({
      context: 128000,
      output: 16384,
    })
  })
})
