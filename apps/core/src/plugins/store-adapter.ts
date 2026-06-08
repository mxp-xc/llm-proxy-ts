import type { PluginStore } from './types.js';
import type { AuthFileData } from '../oauth/token-store.js';
import { PLUGINS_KEY, loadAuthFile, saveAuthFile } from '../oauth/token-store.js';

/**
 * 创建 PluginStore 实例，backed by auth.json 的 _plugins 子树。
 *
 * 数据结构：
 * ```json
 * {
 *   "provider-a": { "accessToken": "...", ... },
 *   "_plugins": {
 *     "my-auth:baidu:token": "xxx",
 *     "my-auth:zhipu:token": "yyy"
 *   }
 * }
 * ```
 *
 * 每次读写都会操作磁盘文件（auth.json），适用于低频操作（如 token 缓存）。
 * 全局 store 不隔离，插件用 key 命名空间管理。
 */
export function createPluginStore(authFilePath: string): PluginStore {
  return {
    async get(key: string): Promise<string | undefined> {
      const data = await loadAuthFile(authFilePath);
      const plugins = data[PLUGINS_KEY];
      if (typeof plugins !== 'object' || plugins === null) {
        return undefined;
      }
      const value = (plugins as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : undefined;
    },

    async set(key: string, value: string): Promise<void> {
      const data = await loadAuthFile(authFilePath);
      const plugins = (typeof data[PLUGINS_KEY] === 'object' && data[PLUGINS_KEY] !== null)
        ? { ...(data[PLUGINS_KEY] as Record<string, unknown>) }
        : {};

      plugins[key] = value;
      data[PLUGINS_KEY] = plugins;

      await saveAuthFile(authFilePath, data);
    },
  };
}
