import { describe, expect, it } from 'vitest'
import type { Settings } from '../../src/index.js'
import type { ResolvedPlugin, AuthPlugin, ProxyPlugin } from '../../src/plugins/types.js'
import { validatePluginConstraints } from '../../src/plugins/registry.js'
import { makeSettings } from '../helpers/settings.js'

function makeAuthPlugin(name: string): AuthPlugin {
  return {
    name,
    async createFetch() {
      return (baseFetch) => baseFetch ?? globalThis.fetch
    },
  }
}

function makeProxyPlugin(name: string): ProxyPlugin {
  return {
    name,
    async inspectStreamChunk() {},
  }
}

function makeResolvedPlugin(
  plugin: AuthPlugin | ProxyPlugin,
  providers: string[] = [],
): ResolvedPlugin {
  return {
    plugin,
    config: {},
    providers,
  }
}

describe('validatePluginConstraints', () => {
  it('passes when no auth plugins are present', () => {
    const settings = makeSettings({
      'test-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test',
        headers: {},
        plugins: [],
        models: {},
      },
    })

    const globalPlugins = [makeResolvedPlugin(makeProxyPlugin('proxy-1'))]
    const providerPlugins = new Map<string, ResolvedPlugin[]>()
    const modelPlugins = new Map<string, Map<string, ResolvedPlugin[]>>()

    expect(() =>
      validatePluginConstraints(globalPlugins, providerPlugins, modelPlugins, settings),
    ).not.toThrow()
  })

  it('passes when auth plugin targets a provider without oauth', () => {
    const settings = makeSettings({
      'my-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test',
        headers: {},
        plugins: [],
        models: {},
      },
    })

    const authPlugin = makeAuthPlugin('my-auth')
    const globalPlugins = [makeResolvedPlugin(authPlugin, ['my-provider'])]
    const providerPlugins = new Map<string, ResolvedPlugin[]>()
    const modelPlugins = new Map<string, Map<string, ResolvedPlugin[]>>()

    expect(() =>
      validatePluginConstraints(globalPlugins, providerPlugins, modelPlugins, settings),
    ).not.toThrow()
  })

  it('throws when auth plugin has no provider targets', () => {
    const settings = makeSettings({
      'my-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test',
        headers: {},
        plugins: [],
        models: {},
      },
    })

    const authPlugin = makeAuthPlugin('my-auth')
    const globalPlugins = [makeResolvedPlugin(authPlugin, [])]
    const providerPlugins = new Map<string, ResolvedPlugin[]>()
    const modelPlugins = new Map<string, Map<string, ResolvedPlugin[]>>()

    expect(() =>
      validatePluginConstraints(globalPlugins, providerPlugins, modelPlugins, settings),
    ).toThrow(/must target at least one provider/)
  })

  it('throws when auth plugin targets a provider with oauth', () => {
    const settings = makeSettings({
      'oauth-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: null,
        headers: {},
        plugins: [],
        models: {},
        oauth: {
          flow: 'client_credentials',
          clientId: 'test-id',
          clientSecret: 'test-secret',
          tokenUrl: 'https://auth.example.com/token',
          scopes: [],
        },
      },
    })

    const authPlugin = makeAuthPlugin('clash-auth')
    const globalPlugins = [makeResolvedPlugin(authPlugin, ['oauth-provider'])]
    const providerPlugins = new Map<string, ResolvedPlugin[]>()
    const modelPlugins = new Map<string, Map<string, ResolvedPlugin[]>>()

    expect(() =>
      validatePluginConstraints(globalPlugins, providerPlugins, modelPlugins, settings),
    ).toThrow(/cannot have both oauth and auth plugin/)
  })

  it('throws when auth plugin is at provider level', () => {
    const settings = makeSettings({
      'test-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test',
        headers: {},
        plugins: [],
        models: {},
      },
    })

    const authPlugin = makeAuthPlugin('provider-auth')
    const globalPlugins: ResolvedPlugin[] = []
    const providerPlugins = new Map<string, ResolvedPlugin[]>([
      ['test-provider', [makeResolvedPlugin(authPlugin, ['test-provider'])]],
    ])
    const modelPlugins = new Map<string, Map<string, ResolvedPlugin[]>>()

    expect(() =>
      validatePluginConstraints(globalPlugins, providerPlugins, modelPlugins, settings),
    ).toThrow(/cannot be configured at provider level/)
  })

  it('throws when auth plugin is at model level', () => {
    const settings = makeSettings({
      'test-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test',
        headers: {},
        plugins: [],
        models: {},
      },
    })

    const authPlugin = makeAuthPlugin('model-auth')
    const globalPlugins: ResolvedPlugin[] = []
    const providerPlugins = new Map<string, ResolvedPlugin[]>()
    const modelPlugins = new Map<string, Map<string, ResolvedPlugin[]>>([
      [
        'test-provider',
        new Map([['model-a', [makeResolvedPlugin(authPlugin, ['test-provider'])]]]),
      ],
    ])

    expect(() =>
      validatePluginConstraints(globalPlugins, providerPlugins, modelPlugins, settings),
    ).toThrow(/cannot be configured at model level/)
  })

  it('passes with empty plugin lists', () => {
    const settings = makeSettings()
    const globalPlugins: ResolvedPlugin[] = []
    const providerPlugins = new Map<string, ResolvedPlugin[]>()
    const modelPlugins = new Map<string, Map<string, ResolvedPlugin[]>>()

    expect(() =>
      validatePluginConstraints(globalPlugins, providerPlugins, modelPlugins, settings),
    ).not.toThrow()
  })
})
