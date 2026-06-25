import type { Settings } from '../../src/index.js'

export const baseSettings: Settings = {
  service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
  requestTimeoutMs: 30000,
  proxy: null,
  routing: { enableFlatModelLookup: false },
  plugins: [],
  codex: { context_window: 200000 },
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
    codex: { ...baseSettings.codex },
    providers,
    ...overrides,
  }
}
