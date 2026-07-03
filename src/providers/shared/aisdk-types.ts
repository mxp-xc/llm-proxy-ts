import type { ToolSet, FinishReason, LanguageModelUsage, ProviderMetadata } from 'ai'

/** 协议映射器产生的消息内容分片 */
export type ProtocolMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; providerOptions?: Record<string, Record<string, unknown>> }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: Record<string, unknown> | string
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output:
        | { type: 'text'; value: string }
        | { type: 'error-text'; value: string }
        | { type: 'json'; value: unknown } // json value 本质任意，属工具结果例外
    }

/** 协议映射器产生的消息 — 统一三种协议的消息表达 */
export type ProtocolMessage =
  | { role: 'user'; content: string | ProtocolMessagePart[] }
  | { role: 'assistant'; content: string | ProtocolMessagePart[] }
  | { role: 'system'; content: string }
  | { role: 'tool'; content: ProtocolMessagePart[] }

export interface AISDKInput {
  system?: string
  /** 协议映射器产生的消息 — 由 ProtocolMessage 判别联合统一三种协议的消息表达；
   *  由 gateway.ts 的 `as Parameters<typeof generateText>[0]` 转换为 SDK 类型 */
  messages: ProtocolMessage[]
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
 * - tool-call.input / tool-result.output / tool-error.input 为 unknown（非工具泛型参数）
 * - 加入 openai-error（代理层首包检测注入）
 * - finish 额外携带 response?（由 stream-normalize 从 finish-step.response 注入，
 *   AI SDK 原生 finish 无此字段）
 * - tool-input-start 保留 providerExecuted（hosted tool 判别标志），省略 toolMetadata
 */
export type ProxyStreamPart =
  | { type: 'text-start'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'text-end'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'text-delta'; id: string; providerMetadata?: ProviderMetadata; text: string }
  | { type: 'reasoning-start'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'reasoning-delta'; id: string; providerMetadata?: ProviderMetadata; text: string }
  | { type: 'reasoning-end'; id: string; providerMetadata?: ProviderMetadata }
  | {
      type: 'tool-input-start'
      id: string
      toolName: string
      providerMetadata?: ProviderMetadata
      providerExecuted?: boolean
      dynamic?: boolean
      title?: string
    }
  | { type: 'tool-input-end'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'tool-input-delta'; id: string; delta: string; providerMetadata?: ProviderMetadata }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
      providerMetadata?: ProviderMetadata
      providerExecuted?: boolean
      dynamic?: boolean
    }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: unknown
      providerMetadata?: ProviderMetadata
    }
  | {
      type: 'tool-error'
      toolCallId: string
      toolName: string
      input: unknown
      error: unknown
      providerMetadata?: ProviderMetadata
      dynamic?: boolean
    }
  | {
      type: 'tool-output-denied'
      toolCallId: string
      toolName: string
      providerExecuted?: boolean
      dynamic?: boolean
    }
  | {
      type: 'tool-approval-request'
      approvalId: string
      toolCall: { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      signature?: string
    }
  | {
      type: 'source'
      providerMetadata?: ProviderMetadata
      sourceType: string
      id?: string
      url?: string
      title?: string
    }
  | { type: 'file'; file: unknown; providerMetadata?: ProviderMetadata }
  | { type: 'start-step'; request: unknown; warnings: unknown[] }
  | {
      type: 'finish-step'
      response: unknown
      usage: LanguageModelUsage
      finishReason: FinishReason
      rawFinishReason: string | undefined
      providerMetadata: ProviderMetadata | undefined
    }
  | { type: 'start' }
  | {
      type: 'finish'
      finishReason: FinishReason
      rawFinishReason: string | undefined
      totalUsage: LanguageModelUsage
      response?: { id?: string; timestamp?: Date }
    }
  | { type: 'abort'; reason?: string }
  | { type: 'error'; error: unknown }
  | { type: 'raw'; rawValue: unknown }
  | { type: 'openai-error'; body: unknown }
