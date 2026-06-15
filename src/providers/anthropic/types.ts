/**
 * Anthropic Messages API 类型定义。
 *
 * 基于 Anthropic Messages API 官方规范。
 * v0 仅覆盖核心类型（text、tool_use、tool_result），
 * image、thinking、document 等后续迭代。
 */

// ─── Cache Control ─────────────────────────────────────────────

export interface CacheControlEphemeral {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

// ─── Content Blocks（请求侧）─────────────────────────────────────

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: CacheControlEphemeral
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | AnthropicTextBlock[]
  is_error?: boolean
  cache_control?: CacheControlEphemeral
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

// ─── System Prompt ─────────────────────────────────────────────

export interface AnthropicSystemTextBlock {
  type: 'text'
  text: string
  cache_control?: CacheControlEphemeral
}

// ─── Messages ──────────────────────────────────────────────────

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

// ─── Tools ─────────────────────────────────────────────────────

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  cache_control?: CacheControlEphemeral
  type?: 'custom'
}

// ─── Tool Choice ───────────────────────────────────────────────

export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'none' }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }

// ─── Thinking ──────────────────────────────────────────────────

export type AnthropicThinking =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' }

// ─── Stop Reason ───────────────────────────────────────────────

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'

// ─── Response（非流式）────────────────────────────────────────────

export interface AnthropicTextResponseBlock {
  type: 'text'
  text: string
}

export interface AnthropicToolUseResponseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type AnthropicResponseContentBlock =
  | AnthropicTextResponseBlock
  | AnthropicToolUseResponseBlock

export interface AnthropicMessageResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: AnthropicResponseContentBlock[]
  stop_reason: AnthropicStopReason | null
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number }
}

// ─── Error ─────────────────────────────────────────────────────

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'timeout_error'
  | 'overloaded_error'
  | 'api_error'

export interface AnthropicErrorResponse {
  type: 'error'
  error: { type: AnthropicErrorType; message: string }
}

// ─── SSE Streaming Events ────────────────────────────────────────

export interface AnthropicSSETextContentBlock {
  type: 'text'
  text: string
}

export interface AnthropicSSEToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicSSEMessageStart {
  type: 'message_start'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    content: never[]
    model: string
    stop_reason: null
    stop_sequence: null
    usage: { input_tokens: number; output_tokens: number }
  }
}

export interface AnthropicSSEContentBlockStart {
  type: 'content_block_start'
  index: number
  content_block: AnthropicSSETextContentBlock | AnthropicSSEToolUseContentBlock
}

export interface AnthropicSSEContentBlockDeltaText {
  type: 'content_block_delta'
  index: number
  delta: { type: 'text_delta'; text: string }
}

export interface AnthropicSSEContentBlockDeltaJson {
  type: 'content_block_delta'
  index: number
  delta: { type: 'input_json_delta'; partial_json: string }
}

export type AnthropicSSEContentBlockDelta =
  | AnthropicSSEContentBlockDeltaText
  | AnthropicSSEContentBlockDeltaJson

export interface AnthropicSSEContentBlockStop {
  type: 'content_block_stop'
  index: number
}

export interface AnthropicSSEMessageDelta {
  type: 'message_delta'
  delta: { stop_reason: AnthropicStopReason | null; stop_sequence: string | null }
  usage?: { input_tokens: number; output_tokens: number }
}

export interface AnthropicSSEMessageStop {
  type: 'message_stop'
}

export interface AnthropicSSEError {
  type: 'error'
  error: { type: string; message: string }
}

export type AnthropicSSEData =
  | AnthropicSSEMessageStart
  | AnthropicSSEContentBlockStart
  | AnthropicSSEContentBlockDelta
  | AnthropicSSEContentBlockStop
  | AnthropicSSEMessageDelta
  | AnthropicSSEMessageStop
  | AnthropicSSEError
