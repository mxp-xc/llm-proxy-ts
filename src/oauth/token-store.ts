import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { OAuthToken, TokenStore } from './types.js'

/**
 * auth.json 的完整数据结构。
 *
 * 顶层 provider name 键对应 OAuthToken（OAuth 模块使用）。
 * `_plugins` 子树供 auth 插件持久化使用。
 */
export interface AuthFileData {
  [providerName: string]: OAuthToken | Record<string, unknown>
  _plugins?: Record<string, Record<string, unknown>>
}

/** `_plugins` 子树的键名 */
export const PLUGINS_KEY = '_plugins'

/**
 * 从 auth.json 文件加载完整数据。
 * 文件不存在返回空对象；JSON 损坏返回空对象。
 */
export async function loadAuthFile(filePath: string): Promise<AuthFileData> {
  if (!existsSync(filePath)) {
    return {}
  }

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as AuthFileData
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * 原子写入完整数据到 auth.json。
 * 先写临时文件再 rename，防止写入中途崩溃导致文件损坏。
 */
export async function saveAuthFile(filePath: string, data: AuthFileData): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })

  const tmpPath = join(dirname(filePath), `.auth.json.tmp-${process.pid}`)
  const content = `${JSON.stringify(data, null, 2)}\n`

  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, filePath)
}

/**
 * 从 AuthFileData 中提取 OAuth TokenStore 部分。
 * 只返回值为对象且包含 accessToken 字段的条目。
 */
export function extractTokenStore(data: AuthFileData): TokenStore {
  const store: TokenStore = {}
  for (const [key, value] of Object.entries(data)) {
    if (key === PLUGINS_KEY) continue
    if (typeof value === 'object' && value !== null && 'accessToken' in value) {
      store[key] = value as OAuthToken
    }
  }
  return store
}

/**
 * 将 TokenStore 合并回 AuthFileData，保留 _plugins 等非 OAuth 数据。
 */
export function mergeTokenStore(data: AuthFileData, store: TokenStore): AuthFileData {
  const result: AuthFileData = { ...data }
  // 写入所有 token
  for (const [key, value] of Object.entries(store)) {
    result[key] = value
  }
  // 删除旧 token 中不在新 store 里的条目
  for (const key of Object.keys(result)) {
    if (key === PLUGINS_KEY) continue
    if (
      !(key in store) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      'accessToken' in (result[key] as object)
    ) {
      delete result[key]
    }
  }
  return result
}
