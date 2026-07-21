import { TokenManager } from './token-manager.js'
import type { Logger } from '../types.js'

/**
 * 仅当存在 OAuth provider 时创建并加载 TokenManager，否则返回 undefined。
 *
 * 抽取自 cli/models-sync 与 server/server 中重复的 3 行初始化，
 * 语义保持一致：hasOAuth=false → undefined；hasOAuth=true → fromFile + load。
 */
export async function createTokenManagerIfNeeded(
  authFilePath: string,
  hasOAuth: boolean,
  logger?: Logger,
): Promise<TokenManager | undefined> {
  if (!hasOAuth) return undefined
  const tokenManager = TokenManager.fromFile(authFilePath, undefined, logger)
  await tokenManager.load()
  return tokenManager
}
