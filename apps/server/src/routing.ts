import type { PluginConfig, ProviderConfig, Settings } from '@llm-proxy/core';
import { assertKnownPlugins, resolvePluginConfigs } from './plugins/registry.js';

export function isFlatLookupEnabled(provider: ProviderConfig, settings: Settings): boolean {
  return provider.enableFlatModelLookup ?? settings.routing.enableFlatModelLookup;
}

export interface RouteMatch {
  providerName: string;
  provider: ProviderConfig;
  modelKey: string;
  modelSelector: string;
  upstreamModel: string;
  headers: Record<string, string>;
  plugins: PluginConfig[];
}

export class RoutingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly selector: string,
    message: string,
  ) {
    super(message);
  }

  toResponse(): { error: { type: string; code: string; message: string; selector: string } } {
    return {
      error: {
        type: 'routing_error',
        code: this.code,
        message: this.message,
        selector: this.selector,
      },
    };
  }
}

export class RoutingTable {
  private constructor(
    private readonly settings: Settings,
    private readonly flatRoutes: Map<string, RouteMatch>,
  ) {}

  static fromSettings(settings: Settings): RoutingTable {
    const flatRoutes = new Map<string, RouteMatch>();

    for (const [providerName, provider] of Object.entries(settings.providers)) {
      assertKnownPlugins(provider.plugins);

      const flatEnabled = isFlatLookupEnabled(provider, settings);

      for (const [modelKey, model] of Object.entries(provider.models)) {
        const route = buildRoute(providerName, provider, modelKey, `${providerName}/${modelKey}`);
        assertKnownPlugins(route.plugins);

        if (flatEnabled) {
          for (const selector of [modelKey, ...model.aliases]) {
            if (flatRoutes.has(selector)) {
              throw new Error(`ambiguous flat route '${selector}' is configured`);
            }
            flatRoutes.set(selector, route);
          }
        }
      }
    }

    return new RoutingTable(settings, flatRoutes);
  }

  resolve(selector: string): RouteMatch {
    if (Object.keys(this.settings.providers).length === 0) {
      throw new RoutingError(404, 'no_providers_configured', selector, 'No upstream providers are configured');
    }

    if (!selector.includes('/')) {
      const anyFlatEnabled = Object.values(this.settings.providers).some(
        (p) => isFlatLookupEnabled(p, this.settings),
      );

      if (!anyFlatEnabled) {
        throw new RoutingError(404, 'flat_lookup_disabled', selector, 'Flat model lookup is disabled');
      }

      const route = this.flatRoutes.get(selector);
      if (!route) {
        throw new RoutingError(404, 'unknown_model', selector, 'No model route matched requested model selector');
      }
      return route;
    }

    if (selector.split('/').length !== 2) {
      throw new RoutingError(404, 'unknown_model', selector, 'Model selector must use configured provider/model routing');
    }

    const [providerName, requestedModel] = selector.split('/') as [string, string];
    const provider = this.settings.providers[providerName];
    if (!provider) {
      throw new RoutingError(404, 'unknown_provider', selector, 'No provider matched requested model selector');
    }

    if (provider.models[requestedModel]) {
      return buildRoute(providerName, provider, requestedModel, selector);
    }

    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (model.aliases.includes(requestedModel)) {
        return buildRoute(providerName, provider, modelKey, selector);
      }
    }

    throw new RoutingError(404, 'unknown_model', selector, 'No model route matched requested model selector');
  }
}

function buildRoute(
  providerName: string,
  provider: ProviderConfig,
  modelKey: string,
  modelSelector: string,
): RouteMatch {
  const model = provider.models[modelKey];
  if (!model) {
    throw new Error(`Missing model route '${modelKey}'`);
  }

  return {
    providerName,
    provider,
    modelKey,
    modelSelector,
    upstreamModel: model.upstreamModel,
    headers: { ...provider.headers, ...model.headers },
    plugins: resolvePluginConfigs(provider.plugins, model.plugins),
  };
}
