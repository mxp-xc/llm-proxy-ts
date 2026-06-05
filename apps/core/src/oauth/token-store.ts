import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { OAuthToken, TokenStore } from './types.js';

/**
 * 从 auth.json 文件加载 TokenStore。
 * 文件不存在返回空 store；JSON 损坏返回空 store 并记录警告。
 */
export async function loadTokenStore(filePath: string): Promise<TokenStore> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as TokenStore;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * 原子写入 TokenStore 到 auth.json。
 * 先写临时文件再 rename，防止写入中途崩溃导致文件损坏。
 */
export async function saveTokenStore(filePath: string, store: TokenStore): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  const tmpPath = join(dirname(filePath), `.auth.json.tmp-${process.pid}`);
  const content = `${JSON.stringify(store, null, 2)}\n`;

  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}

/**
 * 从 store 中获取指定 provider 的 token。
 */
export function getToken(store: TokenStore, providerName: string): OAuthToken | undefined {
  return store[providerName];
}

/**
 * 设置指定 provider 的 token，返回新的 store（不修改原对象）。
 */
export function setToken(store: TokenStore, providerName: string, token: OAuthToken): TokenStore {
  return { ...store, [providerName]: token };
}
