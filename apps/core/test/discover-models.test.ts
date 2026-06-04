import { describe, expect, it, vi } from 'vitest';
import { fetchUpstreamModels } from '../src/cli/discover-models.js';

describe('fetchUpstreamModels', () => {
  const mockModelList = {
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
      { id: 'claude-3-opus', object: 'model', owned_by: 'anthropic' },
      { id: 'deepseek-r1', object: 'model', owned_by: 'deepseek' },
    ],
  };

  it('fetches and sorts models from upstream', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    });
    vi.stubGlobal('fetch', mockFetch);

    const models = await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
    });

    expect(models).toHaveLength(3);
    expect(models[0]?.id).toBe('claude-3-opus');
    expect(models[1]?.id).toBe('deepseek-r1');
    expect(models[2]?.id).toBe('gpt-4o');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );

    vi.restoreAllMocks();
  });

  it('uses first API key from array', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: ['key-1', 'key-2'],
      proxySettings: null,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer key-1' }),
      }),
    );

    vi.restoreAllMocks();
  });

  it('sends request without auth when apiKey is null', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: null,
      proxySettings: null,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {},
      }),
    );

    vi.restoreAllMocks();
  });

  it('strips trailing slashes from baseURL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1///',
      apiKey: 'test-key',
      proxySettings: null,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/models',
      expect.any(Object),
    );

    vi.restoreAllMocks();
  });

  it('throws on non-200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      fetchUpstreamModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'bad-key',
        proxySettings: null,
      }),
    ).rejects.toThrow('HTTP 401 Unauthorized');

    vi.restoreAllMocks();
  });

  it('throws on unexpected response format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ object: 'list', data: null }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      fetchUpstreamModels({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test-key',
        proxySettings: null,
      }),
    ).rejects.toThrow('Unexpected response format');

    vi.restoreAllMocks();
  });

  it('uses proxy fetch when proxySettings is provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockModelList),
    });
    vi.stubGlobal('fetch', mockFetch);

    const models = await fetchUpstreamModels({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test-key',
      proxySettings: null,
    });

    expect(models).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
