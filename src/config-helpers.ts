import type { ModelRouteConfig, ProviderConfig, Settings } from './config.js'

export function isFlatLookupEnabled(provider: ProviderConfig, settings: Settings): boolean {
  return provider.options?.enableFlatModelLookup ?? settings.routing.enableFlatModelLookup
}

export function resolveModelSupportsVision(
  provider: ProviderConfig,
  model: ModelRouteConfig,
): boolean {
  return model.supports_vision ?? provider.options?.supports_vision ?? true
}
