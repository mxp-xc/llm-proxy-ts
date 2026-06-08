import { describe, it, expect } from 'vitest';
import { createSimpleAuthFetch } from '../src/plugins/helpers.js';
import type { ProviderContext } from '../src/plugins/types.js';
import type { SimpleAuthCredentials } from '../src/plugins/helpers.js';

function makeCtx(overrides?: Partial<ProviderContext>): ProviderContext {
  return {
    id: 'test-provider',
    provider: {
      type: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      apiKey: undefined,
      headers: {},
      plugins: [],
      models: {},
    },
    config: {},
    store: {
      async get() { return undefined; },
      async set() {},
    },
    log: {
      info() {},
      warn() {},
      error() {},
      fatal() {},
      child() { return makeCtx().log; },
    },
    ...overrides,
  };
}

/** 创建一个捕获 fetch 调用参数的 fake fetch */
function captureFetch(): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: Array<{ input: RequestInfo | URL; init?: RequestInit | undefined }>;
} {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit | undefined }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response('ok');
  };
  return { fetch, calls };
}

describe('createSimpleAuthFetch', () => {
  it('should inject headers into the request', async () => {
    const ctx = makeCtx();
    const authFetch = createSimpleAuthFetch(
      async () => ({ headers: { 'X-Custom-Auth': 'token-123' } } satisfies SimpleAuthCredentials),
      ctx,
    );

    const { fetch: baseFetch, calls } = captureFetch();
    await authFetch(baseFetch)('https://api.example.com/v1/chat', {});

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('X-Custom-Auth')).toBe('token-123');
  });

  it('should append query params to the URL', async () => {
    const ctx = makeCtx();
    const authFetch = createSimpleAuthFetch(
      async () => ({ query: { access_token: 'abc123' } } satisfies SimpleAuthCredentials),
      ctx,
    );

    const { fetch: baseFetch, calls } = captureFetch();
    await authFetch(baseFetch)('https://api.example.com/v1/chat', {});

    expect(calls).toHaveLength(1);
    const input = calls[0]!.input;
    const url = typeof input === 'string' ? input : input.toString();
    expect(url).toContain('access_token=abc123');
  });

  it('should handle string URL input', async () => {
    const ctx = makeCtx();
    const authFetch = createSimpleAuthFetch(
      async () => ({ query: { key: 'val' } } satisfies SimpleAuthCredentials),
      ctx,
    );

    const { fetch: baseFetch, calls } = captureFetch();
    await authFetch(baseFetch)('https://api.example.com/v1/chat', {});

    const input = calls[0]!.input;
    expect(typeof input === 'string').toBe(true);
    expect(input).toContain('key=val');
  });

  it('should handle URL object input', async () => {
    const ctx = makeCtx();
    const authFetch = createSimpleAuthFetch(
      async () => ({ query: { key: 'val' } } satisfies SimpleAuthCredentials),
      ctx,
    );

    const { fetch: baseFetch, calls } = captureFetch();
    await authFetch(baseFetch)(new URL('https://api.example.com/v1/chat'), {});

    const input = calls[0]!.input;
    const url = typeof input === 'string' ? input : input.toString();
    expect(url).toContain('key=val');
  });

  it('should handle Request object input', async () => {
    const ctx = makeCtx();
    const authFetch = createSimpleAuthFetch(
      async () => ({ headers: { Authorization: 'Bearer tok' } } satisfies SimpleAuthCredentials),
      ctx,
    );

    const { fetch: baseFetch, calls } = captureFetch();
    const req = new Request('https://api.example.com/v1/chat', { method: 'POST' });
    await authFetch(baseFetch)(req, {});

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });

  it('should compose with a base fetch (proxy)', async () => {
    const ctx = makeCtx();
    const authFetch = createSimpleAuthFetch(
      async () => ({ headers: { 'X-Auth': 'signed' } } satisfies SimpleAuthCredentials),
      ctx,
    );

    const { fetch: proxyFetch, calls } = captureFetch();
    const wrapped = authFetch(proxyFetch);
    const result = await wrapped('https://api.example.com/v1/chat', {});

    expect(calls).toHaveLength(1);
    expect(result).toBeInstanceOf(Response);

    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('X-Auth')).toBe('signed');
  });

  it('should handle both headers and query simultaneously', async () => {
    const ctx = makeCtx();
    const authFetch = createSimpleAuthFetch(
      async () => ({
        headers: { 'X-Api-Key': 'my-key' },
        query: { version: '2' },
      } satisfies SimpleAuthCredentials),
      ctx,
    );

    const { fetch: baseFetch, calls } = captureFetch();
    await authFetch(baseFetch)('https://api.example.com/v1/chat', {});

    const input = calls[0]!.input;
    const url = typeof input === 'string' ? input : input.toString();
    expect(url).toContain('version=2');

    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('X-Api-Key')).toBe('my-key');
  });

  it('should work when acquireCredentials returns empty credentials', async () => {
    const ctx = makeCtx();
    const authFetch = createSimpleAuthFetch(
      async () => ({}) satisfies SimpleAuthCredentials,
      ctx,
    );

    const { fetch: baseFetch, calls } = captureFetch();
    await authFetch(baseFetch)('https://api.example.com/v1/chat', { method: 'POST' });

    expect(calls).toHaveLength(1);
    const input = calls[0]!.input;
    const url = typeof input === 'string' ? input : input.toString();
    expect(url).toBe('https://api.example.com/v1/chat');
    expect(calls[0]!.init?.method).toBe('POST');
  });
});
