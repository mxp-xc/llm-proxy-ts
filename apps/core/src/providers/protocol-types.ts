/**
 * 协议层共享类型，供 OpenAI 和 Anthropic renderer 共用。
 */

export type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | undefined

export interface RenderResultInput {
  model: string
  text: string
  finishReason?: FinishReason
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  response?: { id?: string; timestamp?: Date }
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
}
