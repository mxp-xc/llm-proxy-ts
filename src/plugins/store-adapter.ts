import type { PluginStore } from './types.js'
import { PLUGINS_KEY, loadAuthFile, updateAuthFile } from '../oauth/token-store.js'

/**
 * 创建 PluginStore 实例，backed by auth.json 的 _plugins.{pluginName} 子树。
 *
 * 数据结构：
 * ```json
 * {
 *   "provider-a": { "accessToken": "...", ... },
 *   "_plugins": {
 *     "demo-auth": { "accessToken": "xxx", "expiresAt": "123" },
 *     "w3-auth": { "w3": { "accessToken": "yyy" } }
 *   }
 * }
 * ```
 *
 * 每次读写都会操作磁盘文件（auth.json），适用于低频操作（如 token 缓存）。
 */
export function createPluginStore(authFilePath: string, pluginName: string): PluginStore {
  return {
    async get(): Promise<Record<string, unknown>> {
      const data = await loadAuthFile(authFilePath)
      const plugins = data[PLUGINS_KEY]
      if (typeof plugins !== 'object' || plugins === null) return {}
      const subtree = (plugins as Record<string, Record<string, unknown>>)[pluginName]
      if (typeof subtree !== 'object' || subtree === null) return {}
      return { ...subtree }
    },

    async set(data: Record<string, unknown>): Promise<void> {
      await updateAuthFile(authFilePath, (fileData) => {
        const plugins =
          typeof fileData[PLUGINS_KEY] === 'object' && fileData[PLUGINS_KEY] !== null
            ? { ...(fileData[PLUGINS_KEY] as Record<string, Record<string, unknown>>) }
            : {}

        plugins[pluginName] = data
        fileData[PLUGINS_KEY] = plugins

        return fileData
      })
    },
  }
}
