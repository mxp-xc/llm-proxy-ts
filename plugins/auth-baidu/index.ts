import type { AuthPlugin, AuthPluginContext, SimpleAuthCredentials } from '@llm-proxy/core';
import { createSimpleAuthFetch } from '@llm-proxy/core';

/**
 * 百度文心一言认证插件。
 *
 * 百度使用两步流程：
 * 1. POST 到 token 端点（client_credentials）→ 获取 access_token（30 天有效期）
 * 2. 将 access_token 作为 URL query 参数传递（非 Authorization header）
 */
export default {
  name: 'baidu-auth',

  validateConfig(config: Record<string, unknown>): void {
    if (typeof config.clientId !== 'string' || !config.clientId) {
      throw new Error('baidu-auth requires config.clientId');
    }
    if (typeof config.clientSecret !== 'string' || !config.clientSecret) {
      throw new Error('baidu-auth requires config.clientSecret');
    }
  },

  createFetch(ctx: AuthPluginContext) {
    return createSimpleAuthFetch(
      (ctx) => acquireBaiduToken(ctx),
      ctx,
    );
  },
} satisfies AuthPlugin;

interface BaiduTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function acquireBaiduToken(ctx: AuthPluginContext): Promise<SimpleAuthCredentials> {
  const clientId = ctx.config['clientId'] as string;
  const clientSecret = ctx.config['clientSecret'] as string;

  // 检查缓存的 token
  const cachedToken = await ctx.store?.get('accessToken');
  const cachedExpiry = await ctx.store?.get('expiresAt');
  if (cachedToken && cachedExpiry) {
    const expiresAt = Number(cachedExpiry);
    // 5 分钟余量
    if (expiresAt > Date.now() / 1000 + 300) {
      ctx.log.info({ provider: ctx.providerName }, 'using cached baidu token');
      return { query: { access_token: cachedToken } };
    }
  }

  // 获取新 token
  const tokenUrl = 'https://aip.baidubce.com/oauth/2.0/token';
  const response = await fetch(
    `${tokenUrl}?grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
    { method: 'POST' },
  );

  if (!response.ok) {
    throw new Error(`Baidu token fetch failed: HTTP ${response.status}`);
  }

  const data = await response.json() as BaiduTokenResponse;
  if (!data.access_token) {
    throw new Error('Baidu token response missing access_token');
  }

  // 缓存 token
  const expiresAt = Date.now() / 1000 + (data.expires_in || 2592000); // 默认 30 天
  await ctx.store?.set('accessToken', data.access_token);
  await ctx.store?.set('expiresAt', String(expiresAt));

  ctx.log.info({ provider: ctx.providerName }, 'baidu token acquired');

  // 百度要求 token 放 URL query，而非 Authorization header
  return { query: { access_token: data.access_token } };
}
