import type { PluginConfig } from '../config.js';

export const BUILT_IN_PLUGIN_NAMES = new Set(['vendor_sse_error']);

export function resolvePluginConfigs(
  providerPlugins: PluginConfig[],
  modelPlugins: PluginConfig[],
): PluginConfig[] {
  const byName = new Map<string, PluginConfig>();
  for (const plugin of providerPlugins) {
    byName.set(plugin.name, plugin);
  }
  for (const plugin of modelPlugins) {
    byName.set(plugin.name, plugin);
  }
  return [...byName.values()];
}

export function assertKnownPlugins(plugins: PluginConfig[]): void {
  for (const plugin of plugins) {
    if (!BUILT_IN_PLUGIN_NAMES.has(plugin.name)) {
      throw new Error(`Unknown plugin '${plugin.name}'`);
    }
  }
}
