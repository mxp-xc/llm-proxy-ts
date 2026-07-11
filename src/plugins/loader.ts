import type { Plugin } from './types.js'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vendorSseErrorPlugin } from './builtins/vendor-sse-error.js'

// ─── Built-in registry ───────────────────────────────────────────

// Static registry: built-in plugins are wired here at module load via direct
// imports. No runtime registration side effects, no mutable public API.
const builtInPlugins: ReadonlyMap<string, Plugin> = new Map<string, Plugin>([
  ['vendor_sse_error', vendorSseErrorPlugin],
])

/** 按 name 查找内置插件（用于无 PluginRegistry 的向后兼容场景） */
export function getBuiltInPlugin(name: string): Plugin | undefined {
  return builtInPlugins.get(name)
}

// ─── Loader ──────────────────────────────────────────────────────

interface LoadablePluginEntry {
  name?: string | undefined
  module?: string | undefined
}

/**
 * 加载单个插件。
 *
 * - entry.name → 查找内置插件注册表
 * - entry.module → 动态 import（相对路径 / 绝对路径 / npm 包名）
 * - 两者都有 → module 加载，name 用于日志和引用标识
 */
export async function loadPlugin(
  entry: LoadablePluginEntry,
  baseDir: string,
): Promise<{ plugin: Plugin; modulePath?: string }> {
  // 外部插件：有 module 字段
  if (entry.module) {
    const resolvedPath = resolveModulePath(entry.module, baseDir)
    const url = isAbsolute(resolvedPath) ? pathToFileURL(resolvedPath).href : resolvedPath
    const mod = await import(url)
    const plugin: Plugin = mod.default ?? mod
    validatePluginShape(plugin, entry.module)
    return { plugin, modulePath: entry.module }
  }

  // 内置插件：按 name 查找
  if (entry.name) {
    const builtIn = builtInPlugins.get(entry.name)
    if (!builtIn) {
      throw new Error(`Unknown built-in plugin '${entry.name}'`)
    }
    return { plugin: builtIn }
  }

  // 不应到达这里（schema refine 已保证 name 或 module 存在）
  throw new Error('Plugin entry must have name or module')
}

// ─── Helpers ─────────────────────────────────────────────────────

function resolveModulePath(modulePath: string, baseDir: string): string {
  if (isAbsolute(modulePath)) {
    return modulePath
  }
  if (modulePath.startsWith('.')) {
    return resolve(baseDir, modulePath)
  }
  // npm 包名 — 直接 import
  return modulePath
}

function validatePluginShape(plugin: unknown, source: string): asserts plugin is Plugin {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`Plugin at '${source}' must export a default object`)
  }

  const p = plugin as Record<string, unknown>

  if (typeof p.name !== 'string' || !p.name) {
    throw new Error(`Plugin at '${source}' must have a non-empty string 'name' property`)
  }

  // 至少实现一个 hook
  const hookNames = [
    'init',
    'beforeServerStart',
    'afterServerStart',
    'inspectStreamChunk',
    'createFetch',
    'discoverModels',
  ] as const
  const hasHook = hookNames.some((h) => typeof p[h] === 'function')
  if (!hasHook) {
    throw new Error(`Plugin at '${source}' must implement at least one hook`)
  }
}
