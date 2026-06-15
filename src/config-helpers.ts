import type { ProviderConfig, Settings } from './config.js'

export function isFlatLookupEnabled(provider: ProviderConfig, settings: Settings): boolean {
  return provider.options?.enableFlatModelLookup ?? settings.routing.enableFlatModelLookup
}
