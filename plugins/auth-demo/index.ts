import type { AuthPlugin, ProviderContext, SimpleAuthCredentials } from 'llm-proxy'
import { createSimpleAuthFetch } from 'llm-proxy'

/**
 * 示例认证插件：从自定义 token 端点获取 access_token 并注入 Bearer header。
 *
 * 演示 AuthPlugin 的基本写法：
 * - init: 启动时校验必需配置
 * - createFetch: 使用 createSimpleAuthFetch 辅助函数注入 credentials
 * - store: 利用持久化接口缓存 token
 */
export default {
  name: 'demo-auth',

  async init(ctx) {
    const config = ctx.config
    if (typeof config.tokenUrl !== 'string' || !config.tokenUrl) {
      throw new Error('demo-auth requires config.tokenUrl')
    }
    if (typeof config.clientId !== 'string' || !config.clientId) {
      throw new Error('demo-auth requires config.clientId')
    }
    if (typeof config.clientSecret !== 'string' || !config.clientSecret) {
      throw new Error('demo-auth requires config.clientSecret')
    }
  },

  async createFetch(ctx: ProviderContext) {
    return createSimpleAuthFetch((ctx) => acquireToken(ctx), ctx)
  },
} satisfies AuthPlugin

interface TokenResponse {
  access_token: string
  expires_in: number
}

async function acquireToken(ctx: ProviderContext): Promise<SimpleAuthCredentials> {
  const tokenUrl = ctx.config['tokenUrl'] as string
  const clientId = ctx.config['clientId'] as string
  const clientSecret = ctx.config['clientSecret'] as string

  // 检查缓存的 token
  const stored = await ctx.store.get()
  const cachedToken = stored.accessToken as string | undefined
  const cachedExpiry = stored.expiresAt as string | undefined
  if (cachedToken && cachedExpiry) {
    const expiresAt = Number(cachedExpiry)
    if (expiresAt > Date.now() / 1000 + 60) {
      ctx.log.info({ provider: ctx.id }, 'using cached demo-auth token')
      return { headers: { Authorization: `Bearer ${cachedToken}` } }
    }
  }

  // 获取新 token
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
  })

  if (!response.ok) {
    throw new Error(`demo-auth token fetch failed: HTTP ${response.status}`)
  }

  const data = (await response.json()) as TokenResponse
  if (!data.access_token) {
    throw new Error('demo-auth token response missing access_token')
  }

  // 缓存 token
  const expiresAt = Date.now() / 1000 + (data.expires_in ?? 3600)
  await ctx.store.set({ accessToken: data.access_token, expiresAt: String(expiresAt) })

  ctx.log.info({ provider: ctx.id }, 'demo-auth token acquired')

  return { headers: { Authorization: `Bearer ${data.access_token}` } }
}
