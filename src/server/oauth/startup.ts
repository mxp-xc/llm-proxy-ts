import type { Settings, OAuthConfig, ProviderConfig } from '../../config.js'
import { classifyStatus } from '../../oauth/token-manager.js'
import type { TokenManager } from '../../oauth/token-manager.js'
import type { AuthStatus } from '../../oauth/types.js'
import { logger } from '../logging.js'

export interface ProviderAuthStatus {
  provider: string
  status: AuthStatus
  loginUrl?: string
}

/**
 * 单个 OAuth provider 的认证状态判定（valid / needs_refresh+ensureValidToken / needs_login）。
 *
 * 三分支共享核心：`refreshAuthStatuses`（并行 allSettled）与 `validateOAuthStatus`
 * （串行 for...of）均复用本函数，保证语义一致。
 *
 * - valid: token 有效
 * - needs_refresh: 自动 `ensureValidToken`；失败降级 needs_login
 * - needs_login: 构造 loginUrl
 *
 * 每个分支均带 provider 名的日志；`ensureValidToken` 失败时记录完整 `{ err }`。
 */
async function resolveProviderAuthStatus(
  settings: Settings,
  name: string,
  provider: ProviderConfig,
  tokenManager: TokenManager,
): Promise<ProviderAuthStatus> {
  const oauth: OAuthConfig = provider.oauth!
  const status = tokenManager.getStatus(name, oauth)

  if (status === 'valid') {
    logger.info({ provider: name }, 'oauth token valid')
    return { provider: name, status: 'valid' }
  }

  if (status === 'needs_refresh') {
    try {
      await tokenManager.ensureValidToken(name, oauth)
      logger.info({ provider: name }, 'oauth token refreshed')
      return { provider: name, status: 'valid' }
    } catch (err) {
      const loginUrl = buildLoginUrl(settings, name)
      logger.warn(
        { provider: name, loginUrl, err },
        'oauth token refresh failed — login required',
      )
      return { provider: name, status: 'needs_login', loginUrl }
    }
  }

  // needs_login
  const loginUrl = buildLoginUrl(settings, name)
  logger.warn(
    { provider: name, loginUrl },
    'oauth login required — visit the URL to authenticate',
  )
  return { provider: name, status: 'needs_login', loginUrl }
}

/**
 * 在服务启动时检查所有 OAuth provider 的认证状态（串行）。
 *
 * 不阻塞服务启动。保留供测试使用；生产启动路径走 `refreshAuthStatuses`。
 */
export async function validateOAuthStatus(
  settings: Settings,
  tokenManager: TokenManager,
): Promise<ProviderAuthStatus[]> {
  const results: ProviderAuthStatus[] = []

  for (const [name, provider] of Object.entries(settings.providers)) {
    if (!provider.oauth) continue
    results.push(await resolveProviderAuthStatus(settings, name, provider, tokenManager))
  }

  return results
}

/**
 * 并行刷新所有 OAuth provider 的认证状态（非阻塞启动优化）。
 *
 * 与 `validateOAuthStatus` 语义一致，但：
 * - 所有 OAuth provider 并行处理（`Promise.allSettled`）
 * - 永不抛出：单个 provider 异常时降级为 `needs_login` 并记录完整 `{ err }`
 *
 * 启动时后台调用，结果回填到 `authStatuses` 闭包供 `/health` 懒读取。
 * 正确性不依赖本函数：请求路径的 `createOAuthFetch` 会独立调用
 * `ensureValidToken`（内部有 `refreshLocks` 去重），刷新失败时返回 503+loginUrl。
 */
export async function refreshAuthStatuses(
  settings: Settings,
  tokenManager: TokenManager,
): Promise<ProviderAuthStatus[]> {
  const oauthProviders = Object.entries(settings.providers)
    .filter(([, p]) => p.oauth)
    .map(([name, provider]) => ({ name, provider }))

  const settled = await Promise.allSettled(
    oauthProviders.map(({ name, provider }) =>
      resolveProviderAuthStatus(settings, name, provider, tokenManager),
    ),
  )

  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    const { name } = oauthProviders[i]!
    logger.error(
      { provider: name, err: r.reason },
      'oauth status refresh crashed — degrading to needs_login',
    )
    return {
      provider: name,
      status: 'needs_login' as const,
      loginUrl: buildLoginUrl(settings, name),
    }
  })
}

function buildLoginUrl(settings: Settings, providerName: string): string {
  return `http://127.0.0.1:${settings.service.port}/oauth/login/${providerName}`
}

/**
 * 生成启动时使用的 CSRF nonce。
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}
