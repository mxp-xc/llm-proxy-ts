import type { ToolSet, FinishReason, LanguageModelUsage, ProviderMetadata } from 'ai'

export interface AISDKInput {
  system?: string
  /** 协议映射器产生的消息——来自不同协议的请求体，形状不确定；
   *  由 gateway.ts 的 `as Parameters<typeof generateText>[0]` 转换为 SDK 类型 */
  messages: Array<Record<string, unknown>>
  temperature?: number
  topP?: number
  presencePenalty?: number
  frequencyPenalty?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  tools?: ToolSet
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string }
  providerOptions?: Record<string, Record<string, unknown>>
}

/**
 * 代理层流式分片类型 — 基于 AI SDK v6 TextStreamPart 但擦除工具泛型，
 * 并加入代理层注入的 'openai-error' 分片（来自 stream-inspect.ts）。
 *
 * 与 AI SDK 原生 TextStreamPart<TOOLS> 的差异：
 * - tool-call.args / tool-result.result 为 unknown（非工具泛型参数）
 * - 加入 openai-error（代理层首包检测注入）
 * - finish 额外携带 response?（来自 AI SDK finish-step.response）
 */
export type ProxyStreamPart =
  | { type: 'text-start'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'text-end'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'text-delta'; id: string; providerMetadata?: ProviderMetadata; text: string }
  | { type: 'reasoning-start'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'reasoning-delta'; id: string; providerMetadata?: ProviderMetadata; text: string }
  | { type: 'reasoning-end'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'tool-input-start'; id: string; toolName: string; providerMetadata?: ProviderMetadata; dynamic?: boolean; title?: string }
  | { type: 'tool-input-end'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'tool-input-delta'; id: string; delta: string; providerMetadata?: ProviderMetadata }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown; providerMetadata?: ProviderMetadata; dynamic?: boolean }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; providerMetadata?: ProviderMetadata }
  | { type: 'source'; providerMetadata?: ProviderMetadata; sourceType: string; id?: string; url?: string; title?: string }
  | { type: 'file'; file: unknown; providerMetadata?: ProviderMetadata }
  | { type: 'start-step'; request: unknown; warnings: unknown[] }
  | { type: 'finish-step'; response: unknown; usage: LanguageModelUsage; finishReason: FinishReason; rawFinishReason: string | undefined; providerMetadata: ProviderMetadata | undefined }
  | { type: 'start' }
  | { type: 'finish'; finishReason: FinishReason; rawFinishReason: string | undefined; totalUsage: LanguageModelUsage; response?: { id?: string; timestamp?: Date } }
  | { type: 'abort'; reason?: string }
  | { type: 'error'; error: unknown }
  | { type: 'raw'; rawValue: unknown }
  | { type: 'openai-error'; body: unknown }
