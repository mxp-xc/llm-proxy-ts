export function safeProxyHost(proxyUrl: string): string {
  return new URL(proxyUrl).host
}

/**
 * 将代理 URL 规范化为结构化 URL 形式 `protocol://host:port`，剥离用户名/密码等敏感信息。
 * 用于日志输出，例如 `http://127.0.0.1:9000`。
 */
export function safeProxyUrl(proxyUrl: string): string {
  const url = new URL(proxyUrl)
  return `${url.protocol}//${url.host}`
}
