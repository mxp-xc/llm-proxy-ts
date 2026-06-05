import { describe, expect, it, vi } from 'vitest';
import type { Settings, Logger } from '@llm-proxy/core';
import type { ResolvedAuthPlugin } from '../src/auth/types.js';
import { createProviderRegistry } from '../src/providers/registry.js';

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return noopLogger; },
};

/**
 * Create a mock AuthPlugin that tracks calls and returns a fetch wrapper
 * that injects a known header.
 */
function createMockAuthPlugin() {
  const calls: { providerName: string; input: string }[] = [];

  const plugin: ResolvedAuthPlugin = {
    plugin: {
      name: 'mock-auth-plugin',
      createFetch(ctx) {
        return (baseFetch) => async (input, init) => {
          calls.push({ providerName: ctx.providerName, input: String(input) });
          const headers = new Headers(init?.headers);
          headers.set('X-Auth-Plugin', `mock-for-${ctx.providerName}`);
          const fetchFn = baseFetch ?? globalThis.fetch;
          return fetchFn(input, { ...init, headers });
        };
      },
    },
    modulePath: './mock-auth-plugin.mjs',
  };

  return { plugin, calls };
}

// Mock createOpenAICompatibleProvider to avoid needing real AI SDK setup
vi.mock('../src/openai-compatible.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/openai-compatible.js')>();
  return {
    ...original,
    createOpenAICompatibleProvider(
      providerName: string,
      provider: unknown,
      settings: unknown,
      modelHeaders: unknown,
      selectedApiKey: string | undefined,
      authFetch?: (baseFetch?: typeof fetch) => typeof fetch,
    ) {
      return (upstreamModel: string) => ({
        upstreamModel,
        providerName,
        selectedApiKey,
        authFetch: authFetch ? 'present' : 'absent',
      });
    },
    sanitizeHeaders(headers: Record<string, string>) {
      return original.sanitizeHeaders(headers);
    },
  };
});

describe('auth plugin integration with createProviderRegistry', () => {
  it('Provider with auth config should use authFetch (not apiKey)', () => {
    const { plugin: mockPlugin } = createMockAuthPlugin();
    const authPlugins = new Map<string, ResolvedAuthPlugin>();
    authPlugins.set('auth-provider', mockPlugin);

    const settings: Settings = {
      service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
      requestTimeoutMs: 30000,
      proxy: null,
      routing: { enableFlatModelLookup: false },
      providers: {
        'auth-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'should-not-be-used',
          headers: {},
          plugins: [],
          models: {},
          auth: {
            module: './mock-auth-plugin.mjs',
            config: { tokenUrl: 'https://auth.example.com/token' },
          },
        },
      },
    };

    const registry = createProviderRegistry(settings, undefined, noopLogger, authPlugins);
    const model = registry.languageModel('auth-provider', 'upstream-model', {}) as unknown as Record<string, unknown>;

    // authFetch should be present, apiKey should not be passed
    expect(model.authFetch).toBe('present');
    expect(model.selectedApiKey).toBeUndefined();
  });

  it('Provider without auth/oauth should use apiKey as before', () => {
    const settings: Settings = {
      service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
      requestTimeoutMs: 30000,
      proxy: null,
      routing: { enableFlatModelLookup: false },
      providers: {
        'simple-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'my-api-key',
          headers: {},
          plugins: [],
          models: {},
        },
      },
    };

    const registry = createProviderRegistry(settings, undefined, noopLogger);
    const model = registry.languageModel('simple-provider', 'upstream-model', {}) as unknown as Record<string, unknown>;

    expect(model.authFetch).toBe('absent');
    expect(model.selectedApiKey).toBe('my-api-key');
  });

  it('Provider with auth but no matching loaded plugin should throw', () => {
    const { plugin: mockPlugin } = createMockAuthPlugin();
    const authPlugins = new Map<string, ResolvedAuthPlugin>();
    // Plugin loaded under different name, not matching the provider
    authPlugins.set('other-provider', mockPlugin);

    const settings: Settings = {
      service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
      requestTimeoutMs: 30000,
      proxy: null,
      routing: { enableFlatModelLookup: false },
      providers: {
        'auth-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: null,
          headers: {},
          plugins: [],
          models: {},
          auth: {
            module: './mock-auth-plugin.mjs',
            config: {},
          },
        },
      },
    };

    const registry = createProviderRegistry(settings, undefined, noopLogger, authPlugins);

    expect(() => registry.languageModel('auth-provider', 'upstream-model', {})).toThrow(
      /Auth plugin not loaded for provider 'auth-provider'/,
    );
  });
});
