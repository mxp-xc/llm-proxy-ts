import type { Settings } from '../../src/index.js'

export const baseSettings: Settings = {
  service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
  requestTimeoutMs: 30000,
  proxy: null,
  routing: { enableFlatModelLookup: false },
  plugins: [],
  codex: {
    models_catalog: { context_window: 200000 },
    install: { providerId: 'llm-proxy', providerName: 'LLM Proxy', requiresOpenaiAuth: false, checkForUpdateOnStartup: false },
  },
  providers: {},
}

export function makeSettings(
  providers: Settings['providers'] = {},
  overrides: Partial<Omit<Settings, 'providers'>> = {},
): Settings {
  return {
    ...baseSettings,
    service: { ...baseSettings.service },
    routing: { ...baseSettings.routing },
    codex: {
      models_catalog: { ...baseSettings.codex.models_catalog },
      install: { ...baseSettings.codex.install },
    },
    providers,
    ...overrides,
  }
}
