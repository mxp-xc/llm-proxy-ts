/**
 * 协议层共享类型，供 OpenAI 和 Anthropic renderer 共用。
 */

export type FinishReason =
  'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | undefined

/** namespace 工具拍平名 → 原始 {namespace, name} 映射条目。
 *  namespace 为 undefined 表示顶层 function（无 namespace 包裹）。 */
export interface NamespaceFlatEntry {
  namespace: string | undefined
  name: string
}

/** namespace 拍平映射：flatName(`${namespace}__${name}` 或 name) → {namespace, name}。
 *  请求侧构建（request.tools namespace + input tool_search_output），响应侧用于把
 *  GLM 返回的拍平 toolName 拆回 codex 期望的 {name, namespace} 分离字段。 */
export type NamespaceFlatMap = Map<string, NamespaceFlatEntry>

export interface RenderResultInput {
  model: string
  text: string
  finishReason?: FinishReason
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    reasoningTokens?: number
  }
  response?: { id?: string; timestamp?: Date }
  toolCalls?: Array<{
    toolCallId: string
    toolName: string
    input: unknown
    providerExecuted?: boolean
  }>
}

/**
 * 将任意错误值安全转换为人类可读的错误消息。
 *
 * 比 `String(err)` 更健壮——普通对象不会产生 `[object Object]`。
 * 供 renderer 及其他需要显示错误信息的模块共用。
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return 'Unknown error'
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Type guard: checks if a value is a non-null object (not an array check needed for this use case).
 * Shared across all renderers.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
