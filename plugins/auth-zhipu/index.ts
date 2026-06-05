import type { AuthPlugin, AuthPluginContext, SimpleAuthCredentials } from '@llm-proxy/core';
import { createSimpleAuthFetch } from '@llm-proxy/core';

/**
 * 智谱AI (GLM) 认证插件。
 *
 * 智谱AI 使用 JWT 自签名：
 * - API Key 格式为 `id.secret`
 * - 客户端自行生成 JWT，包含自定义 claims：
 *   { api_key: id, exp: now_ms + 3600000, timestamp: now_ms }
 * - JWT header 包含非标准字段 `sign_type: "SIGN"`
 * - 签名算法为 HMAC-SHA256，密钥为 secret 部分
 * - 生成的 JWT 作为 `Authorization: Bearer {jwt}` 传递
 *
 * 无需持久化（JWT 每次请求都可重新生成）。
 */
export default {
  name: 'zhipu-auth',

  validateConfig(config: Record<string, unknown>): void {
    if (typeof config.apiKey !== 'string' || !config.apiKey.includes('.')) {
      throw new Error('zhipu-auth requires config.apiKey in "id.secret" format');
    }
  },

  createFetch(ctx: AuthPluginContext) {
    return createSimpleAuthFetch(
      (ctx) => generateZhipuJWT(ctx),
      ctx,
    );
  },
} satisfies AuthPlugin;

async function generateZhipuJWT(ctx: AuthPluginContext): Promise<SimpleAuthCredentials> {
  const apiKey = ctx.config['apiKey'] as string;
  const [id, secret] = apiKey.split('.');

  if (!id || !secret) {
    throw new Error('Invalid ZhipuAI apiKey format: expected "id.secret"');
  }

  const now = Date.now();
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' }));
  const payload = base64urlEncode(JSON.stringify({
    api_key: id,
    exp: now + 3600 * 1000,
    timestamp: now,
  }));

  const signatureInput = `${header}.${payload}`;
  const signature = await hmacSha256Base64url(secret, signatureInput);
  const jwt = `${signatureInput}.${signature}`;

  return { headers: { Authorization: `Bearer ${jwt}` } };
}

function base64urlEncode(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64url');
}

async function hmacSha256Base64url(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return Buffer.from(sig).toString('base64url');
}
