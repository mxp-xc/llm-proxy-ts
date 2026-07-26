import type { OAuthConfig } from '../config.js'
import { noopLogger, type Logger } from '../types.js'
import type { AuthStatus, OAuthToken, OAuthTokenResponse, TokenStore } from './types.js'
import { OAuthError } from './types.js'
import { loadAuthFile, extractTokenStore, saveTokenStore } from './token-store.js'

/** Token 过期前的提前刷新余量（秒） */
const EXPIRY_MARGIN_SECONDS = 30

/**
 * Token 持久化抽象，解耦 TokenManager 与文件系统。
 *
 * - `load()` 返回纯 TokenStore（不含 _plugins 等非 OAuth 数据）
 * - `save()` 负责合并回完整持久化存储，保留非 OAuth 字段
 */
export interface TokenPersistence {
  load(): Promise<TokenStore>
  save(store: TokenStore): Promise<void>
}

/**
 * 检查 token 是否仍然有效（未过期）。
 */
export function isTokenValid(token: OAuthToken): boolean {
  return token.expiresAt > Date.now() / 1000 + EXPIRY_MARGIN_SECONDS
}

/**
 * 判断 token 是否已过期（access_token 超出余量）。
 */
export function isTokenExpired(token: OAuthToken): boolean {
  return !isTokenValid(token)
}

/**
 * 分类 provider 的认证状态。
 */
export function classifyStatus(token: OAuthToken | undefined, config: OAuthConfig): AuthStatus {
  if (!token) {
    return config.flow === 'client_credentials' ? 'needs_refresh' : 'needs_login'
  }

  if (isTokenValid(token)) {
    return 'valid'
  }

  // access_token 过期
  if (config.flow === 'client_credentials') {
    return 'needs_refresh'
  }

  // authorization_code: 有 refreshToken 则可刷新
  if (token.refreshToken) {
    return 'needs_refresh'
  }

  return 'needs_login'
}

/**
 * 使用 refresh_token 刷新 access_token。
 */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  if (config.scopes.length > 0) {
    body.set('scope', config.scopes.join(' '))
  }

  try {
    signal?.throwIfAborted()
    const response = await fetchFn(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...(signal ? { signal } : {}),
    })

    if (!response.ok) {
      throw new OAuthError('refresh_failed', `Token refresh failed: HTTP ${response.status}`)
    }

    return parseTokenResponse(
      await parseTokenEndpointJson(response, 'refresh_failed', 'Token refresh failed'),
      'refresh_failed',
    )
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted()
    if (error instanceof OAuthError) throw error
    throw new OAuthError('refresh_failed', `Token refresh failed: ${String(error)}`, {
      cause: error,
    })
  }
}

/**
 * 使用 client_credentials 获取 token。
 */
export async function fetchClientCredentialsToken(
  config: OAuthConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  if (config.scopes.length > 0) {
    body.set('scope', config.scopes.join(' '))
  }

  try {
    signal?.throwIfAborted()
    const response = await fetchFn(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...(signal ? { signal } : {}),
    })

    if (!response.ok) {
      throw new OAuthError(
        'refresh_failed',
        `Client credentials token fetch failed: HTTP ${response.status}`,
      )
    }

    return parseTokenResponse(
      await parseTokenEndpointJson(
        response,
        'refresh_failed',
        'Client credentials token fetch failed',
      ),
      'refresh_failed',
    )
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted()
    if (error instanceof OAuthError) throw error
    throw new OAuthError(
      'refresh_failed',
      `Client credentials token fetch failed: ${String(error)}`,
      { cause: error },
    )
  }
}

/**
 * 使用 authorization_code 交换 token。
 */
export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
  })

  try {
    signal?.throwIfAborted()
    const response = await fetchFn(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...(signal ? { signal } : {}),
    })

    if (!response.ok) {
      throw new OAuthError(
        'exchange_failed',
        `Authorization code exchange failed: HTTP ${response.status}`,
      )
    }

    return parseTokenResponse(
      await parseTokenEndpointJson(
        response,
        'exchange_failed',
        'Authorization code exchange failed',
      ),
      'exchange_failed',
    )
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted()
    if (error instanceof OAuthError) throw error
    throw new OAuthError(
      'exchange_failed',
      `Authorization code exchange failed: ${String(error)}`,
      {
        cause: error,
      },
    )
  }
}

/**
 * 解析 OAuth token 端点的 JSON 响应。
 */
type TokenEndpointFailureCode = 'refresh_failed' | 'exchange_failed'

async function parseTokenEndpointJson(
  response: Response,
  failureCode: TokenEndpointFailureCode,
  operation: string,
): Promise<OAuthTokenResponse> {
  try {
    return (await response.json()) as OAuthTokenResponse
  } catch {
    // Native JSON parse errors can include a snippet of the token endpoint body.
    throw new OAuthError(failureCode, `${operation}: token endpoint returned invalid JSON`)
  }
}

function parseTokenResponse(
  data: OAuthTokenResponse,
  failureCode: TokenEndpointFailureCode,
): OAuthToken {
  const accessToken = data['access_token']
  const expiresIn = data['expires_in']
  const tokenType = data['token_type']
  const refreshToken = data['refresh_token']
  const scope = data['scope']

  if (typeof accessToken !== 'string') {
    throw new OAuthError(failureCode, 'Token response missing access_token')
  }

  if (typeof expiresIn !== 'number') {
    throw new OAuthError(failureCode, 'Token response missing expires_in')
  }

  return {
    accessToken,
    expiresAt: Date.now() / 1000 + expiresIn,
    tokenType: typeof tokenType === 'string' ? tokenType : 'Bearer',
    ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
    ...(typeof scope === 'string' ? { scope } : {}),
  }
}

/**
 * Token 生命周期管理器。
 *
 * - 持有内存缓存 + 通过 TokenPersistence 持久化
 * - 并发请求自动去重（同一 provider 同时只做一次刷新）
 */
export class TokenManager {
  private store: TokenStore = {}
  private refreshLocks = new Map<string, RefreshOperation>()
  private exchangeLocks = new Map<string, Set<Promise<OAuthToken>>>()
  private pendingRefreshOperations = new Set<Promise<OAuthToken>>()
  private storeMutationQueue: Promise<void> = Promise.resolve()
  private nextProviderGeneration = new Map<string, number>()
  private persistedProviderGeneration = new Map<string, number>()

  constructor(
    private persistence: TokenPersistence,
    private fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private logger: Logger = noopLogger,
  ) {}

  /**
   * 从 auth.json 文件创建 TokenManager（便捷工厂方法）。
   *
   * 内部创建基于文件系统的 TokenPersistence 实现，
   * 保持与原构造函数相同的外部行为。
   */
  static fromFile(
    authFilePath: string,
    fetchFn?: typeof globalThis.fetch,
    logger?: Logger,
  ): TokenManager {
    const persistence: TokenPersistence = {
      async load(): Promise<TokenStore> {
        const data = await loadAuthFile(authFilePath)
        return extractTokenStore(data)
      },
      async save(store: TokenStore): Promise<void> {
        await saveTokenStore(authFilePath, store)
      },
    }
    return new TokenManager(persistence, fetchFn, logger)
  }

  /**
   * 启动时从持久化存储加载 token。
   */
  async load(): Promise<void> {
    this.store = await this.persistence.load()
  }

  /**
   * 获取指定 provider 的认证状态。
   */
  getStatus(providerName: string, config: OAuthConfig): AuthStatus {
    return classifyStatus(this.store[providerName], config)
  }

  /**
   * 确保返回有效的 token。
   *
   * - 有效则直接返回
   * - 过期但有 refreshToken 则刷新
   * - client_credentials 则重新获取
   * - 否则抛出 OAuthError('auth_required')
   */
  async ensureValidToken(
    providerName: string,
    config: OAuthConfig,
    signal?: AbortSignal,
  ): Promise<OAuthToken> {
    signal?.throwIfAborted()
    const pendingExchanges = this.exchangeLocks.get(providerName)
    if (pendingExchanges?.size) {
      await waitForOperation(Promise.allSettled([...pendingExchanges]), signal)
      return this.ensureValidToken(providerName, config, signal)
    }
    const token = this.store[providerName]

    // 有效 token 直接返回
    if (token && isTokenValid(token)) {
      return token
    }

    // 需要刷新 — 并发去重
    const existing = this.refreshLocks.get(providerName)
    if (existing) {
      existing.joinedRequests++
      return this.waitForRefresh(providerName, existing, signal)
    }

    const flow = resolveRefreshFlow(config, token)
    if (!flow) {
      throw new OAuthError(
        'auth_required',
        `No valid OAuth token for provider '${providerName}'. Visit /oauth/login/${providerName} to authenticate.`,
      )
    }

    const operation: RefreshOperation = {
      controller: new AbortController(),
      joinedRequests: 0,
      activeWaiters: 0,
      settled: false,
      promise: Promise.resolve(undefined as unknown as OAuthToken),
    }
    const generation = this.beginProviderOperation(providerName)
    operation.promise = this.doRefresh(
      providerName,
      config,
      token,
      flow,
      operation,
      generation,
      operation.controller.signal,
    )
    this.refreshLocks.set(providerName, operation)
    this.pendingRefreshOperations.add(operation.promise)
    void operation.promise.then(
      () => this.finishRefreshOperation(providerName, operation),
      () => this.finishRefreshOperation(providerName, operation),
    )
    return this.waitForRefresh(providerName, operation, signal)
  }

  /**
   * 使用 authorization_code 交换 token（回调端点调用）。
   */
  async exchangeCode(
    providerName: string,
    config: OAuthConfig,
    code: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<OAuthToken> {
    signal?.throwIfAborted()
    const generation = this.beginProviderOperation(providerName)
    const operation = waitForOperation(
      this.doExchangeCode(providerName, config, code, redirectUri, generation, signal),
      signal,
    )
    let operations = this.exchangeLocks.get(providerName)
    if (!operations) {
      operations = new Set()
      this.exchangeLocks.set(providerName, operations)
    }
    operations.add(operation)
    void operation.then(
      () => this.finishExchangeOperation(providerName, operation),
      () => this.finishExchangeOperation(providerName, operation),
    )
    return operation
  }

  async waitForPendingRefreshes(): Promise<void> {
    while (this.pendingRefreshOperations.size > 0) {
      await Promise.allSettled(this.pendingRefreshOperations)
    }
  }

  private async waitForRefresh(
    providerName: string,
    operation: RefreshOperation,
    signal?: AbortSignal,
  ): Promise<OAuthToken> {
    signal?.throwIfAborted()
    operation.activeWaiters++
    let onAbort: (() => void) | undefined
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
      : undefined

    try {
      return await (abortPromise
        ? Promise.race([operation.promise, abortPromise])
        : operation.promise)
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      operation.activeWaiters--
      if (operation.activeWaiters === 0 && !operation.settled) {
        if (this.refreshLocks.get(providerName) === operation) {
          this.refreshLocks.delete(providerName)
        }
        if (!operation.controller.signal.aborted) {
          operation.controller.abort(signal?.reason)
        }
      }
    }
  }

  private finishRefreshOperation(providerName: string, operation: RefreshOperation): void {
    operation.settled = true
    this.pendingRefreshOperations.delete(operation.promise)
    if (this.refreshLocks.get(providerName) === operation) {
      this.refreshLocks.delete(providerName)
    }
  }

  private finishExchangeOperation(providerName: string, operation: Promise<OAuthToken>): void {
    const operations = this.exchangeLocks.get(providerName)
    operations?.delete(operation)
    if (operations?.size === 0) this.exchangeLocks.delete(providerName)
  }

  private async doExchangeCode(
    providerName: string,
    config: OAuthConfig,
    code: string,
    redirectUri: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<OAuthToken> {
    const token = await exchangeAuthorizationCode(config, code, redirectUri, this.fetchFn, signal)
    signal?.throwIfAborted()
    return this.persistToken(providerName, token, generation)
  }

  private async doRefresh(
    providerName: string,
    config: OAuthConfig,
    currentToken: OAuthToken | undefined,
    flow: OAuthRefreshFlow,
    operation: RefreshOperation,
    generation: number,
    signal?: AbortSignal,
  ): Promise<OAuthToken> {
    const startedAt = Date.now()
    let stage: OAuthRefreshStage = 'token_endpoint'
    this.logger.info({ provider: providerName, flow }, 'oauth.refresh.started')

    try {
      let token =
        flow === 'client_credentials'
          ? await fetchClientCredentialsToken(config, this.fetchFn, signal)
          : await refreshAccessToken(config, currentToken!.refreshToken!, this.fetchFn, signal)

      if (flow === 'refresh_token') {
        const refreshToken = token.refreshToken ?? currentToken!.refreshToken
        const scope = token.scope ?? currentToken!.scope
        token = {
          ...token,
          ...(refreshToken ? { refreshToken } : {}),
          ...(scope ? { scope } : {}),
        }
      }

      signal?.throwIfAborted()
      stage = 'persist'
      token = await this.persistToken(providerName, token, generation)
      this.logger.info(
        {
          provider: providerName,
          flow,
          joinedRequests: operation.joinedRequests,
          durationMs: Date.now() - startedAt,
        },
        'oauth.refresh.succeeded',
      )
      return token
    } catch (err) {
      const payload = {
        err,
        provider: providerName,
        flow,
        joinedRequests: operation.joinedRequests,
        durationMs: Date.now() - startedAt,
        stage,
      }
      if (signal?.aborted) {
        this.logger.info(payload, 'oauth.refresh.aborted')
      } else {
        this.logger.error(payload, 'oauth.refresh.failed')
      }
      throw err
    }
  }

  private beginProviderOperation(providerName: string): number {
    const generation = (this.nextProviderGeneration.get(providerName) ?? 0) + 1
    this.nextProviderGeneration.set(providerName, generation)
    return generation
  }

  private async persistToken(
    providerName: string,
    token: OAuthToken,
    generation: number,
  ): Promise<OAuthToken> {
    const mutation = this.storeMutationQueue
      .catch(() => undefined)
      .then(async () => {
        if (generation < (this.persistedProviderGeneration.get(providerName) ?? 0)) {
          return this.store[providerName]!
        }

        const nextStore = { ...this.store, [providerName]: token }
        await this.persistence.save(nextStore)
        this.store = nextStore
        this.persistedProviderGeneration.set(providerName, generation)
        return token
      })
    this.storeMutationQueue = mutation.then(
      () => undefined,
      () => undefined,
    )
    return mutation
  }
}

type OAuthRefreshFlow = 'refresh_token' | 'client_credentials'
type OAuthRefreshStage = 'token_endpoint' | 'persist'

interface RefreshOperation {
  promise: Promise<OAuthToken>
  controller: AbortController
  joinedRequests: number
  activeWaiters: number
  settled: boolean
}

function waitForOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
    if (signal.aborted) onAbort()
  })
}

function resolveRefreshFlow(
  config: OAuthConfig,
  currentToken: OAuthToken | undefined,
): OAuthRefreshFlow | undefined {
  if (config.flow === 'client_credentials') return 'client_credentials'
  return currentToken?.refreshToken ? 'refresh_token' : undefined
}
