import type { NamespaceFlatMap } from '../protocol-types.js'

export interface ResponseOutputText {
  type: 'output_text'
  text: string
  annotations: Array<Record<string, unknown>>
}

export interface ResponseOutputMessage {
  id: string
  type: 'message'
  status: 'completed' | 'incomplete'
  role: 'assistant'
  content: Array<ResponseOutputText>
}

export interface ResponseFunctionToolCall {
  id: string
  type: 'function_call'
  status: 'completed' | 'incomplete'
  call_id: string
  name: string
  namespace?: string
  arguments: string
}

export interface ResponseCustomToolCall {
  id: string
  type: 'custom_tool_call'
  status: 'completed' | 'incomplete'
  call_id: string
  name: string
  input: string
}

export interface ResponseWebSearchAction {
  type: 'search' | 'open_page' | 'find_in_page'
  query?: string
  queries?: string[]
  url?: string
  pattern?: string
}

export interface ResponseWebSearchCall {
  id: string
  type: 'web_search_call'
  status: 'completed' | 'incomplete'
  action: ResponseWebSearchAction | null
}

export interface ResponseToolSearchCall {
  id: string
  type: 'tool_search_call'
  call_id: string
  status: 'completed' | 'incomplete'
  execution: 'client'
  arguments: Record<string, unknown>
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseFunctionToolCall
  | ResponseCustomToolCall
  | ResponseWebSearchCall
  | ResponseToolSearchCall

export interface ResponseUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details: { cached_tokens: number }
  output_tokens_details: { reasoning_tokens: number }
}

export interface OpenAIResponse {
  id: string
  object: 'response'
  created_at: number
  model: string
  status: 'completed' | 'incomplete' | 'failed'
  output: ResponseOutputItem[]
  output_text: string
  error?: { code?: string | null; message: string }
  usage?: ResponseUsage
  instructions: string | null
  temperature: number | null
  top_p: number | null
  tool_choice: string | null
  tools: Array<{ type: string; name?: string; [key: string]: unknown }>
  parallel_tool_calls: boolean
  truncation: 'disabled'
}

// ─── Streaming SSE Event Types ──────────────────────────────────

/** Summary item within a reasoning output item */
interface ReasoningSummaryItem {
  type: 'summary_text'
  text: string
}

/** Message item as it appears in streaming output_item events */
interface StreamMessageItem {
  id: string
  type: 'message'
  status: string
  role: string
  content: Array<ResponseOutputText>
}

/** Function call item as it appears in streaming output_item events */
interface StreamFunctionCallItem {
  id: string
  type: 'function_call'
  status: string
  call_id: string
  name: string
  namespace?: string
  arguments: string
}

/** Custom tool call item (apply_patch 等 freeform tool) as it appears in streaming output_item events */
interface StreamCustomToolCallItem {
  id: string
  type: 'custom_tool_call'
  status: string
  call_id: string
  name: string
  input: string
}

/** Web search call item (hosted web_search tool) as it appears in streaming output_item events */
interface StreamWebSearchCallItem {
  id: string
  type: 'web_search_call'
  status: string
  action: ResponseWebSearchAction | null
}

/** Reasoning item as it appears in streaming output_item events */
interface StreamReasoningItem {
  id: string
  type: 'reasoning'
  summary: ReasoningSummaryItem[]
  encrypted_content?: string
}

/** Union of all item shapes that can appear in streaming output_item events */
interface StreamToolSearchCallItem {
  id: string
  type: 'tool_search_call'
  call_id: string
  status: string
  execution: 'client'
  arguments: Record<string, unknown>
}

type StreamOutputItem =
  | StreamMessageItem
  | StreamFunctionCallItem
  | StreamCustomToolCallItem
  | StreamWebSearchCallItem
  | StreamToolSearchCallItem
  | StreamReasoningItem

/** Minimal response object for created/in_progress events */
interface StreamResponsePartial {
  id: string
  object: 'response'
  created_at?: number
  model?: string
  status: string
  output: ResponseOutputItem[]
}

export interface ResponseCreatedEvent {
  type: 'response.created'
  sequence_number: number
  response: StreamResponsePartial
}

interface ResponseInProgressEvent {
  type: 'response.in_progress'
  sequence_number: number
  response: StreamResponsePartial
}

export interface ResponseOutputItemAddedEvent {
  type: 'response.output_item.added'
  sequence_number: number
  output_index: number
  item: StreamOutputItem
}

interface ResponseContentPartAddedEvent {
  type: 'response.content_part.added'
  sequence_number: number
  item_id: string
  output_index: number
  content_index: number
  part: ResponseOutputText
}

export interface ResponseOutputTextDeltaEvent {
  type: 'response.output_text.delta'
  sequence_number: number
  item_id: string
  output_index: number
  content_index: number
  delta: string
}

interface ResponseOutputTextDoneEvent {
  type: 'response.output_text.done'
  sequence_number: number
  item_id: string
  output_index: number
  content_index: number
  text: string
}

interface ResponseContentPartDoneEvent {
  type: 'response.content_part.done'
  sequence_number: number
  item_id: string
  output_index: number
  content_index: number
  part: ResponseOutputText
}

export interface ResponseOutputItemDoneEvent {
  type: 'response.output_item.done'
  sequence_number: number
  output_index: number
  item: StreamOutputItem
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta'
  sequence_number: number
  item_id: string
  output_index: number
  delta: string
}

interface ResponseFunctionCallArgumentsDoneEvent {
  type: 'response.function_call_arguments.done'
  sequence_number: number
  item_id: string
  output_index: number
  arguments: string
}

interface ResponseReasoningSummaryTextDeltaEvent {
  type: 'response.reasoning_summary_text.delta'
  sequence_number: number
  item_id: string
  output_index: number
  delta: string
}

interface ResponseCustomToolCallInputDeltaEvent {
  type: 'response.custom_tool_call_input.delta'
  sequence_number: number
  item_id: string
  output_index: number
  delta: string
}

interface ResponseReasoningSummaryTextDoneEvent {
  type: 'response.reasoning_summary_text.done'
  sequence_number: number
  item_id: string
  output_index: number
  text: string
}

export interface ResponseCompletedEvent {
  type: 'response.completed'
  sequence_number: number
  response: OpenAIResponse
}

export interface ResponseFailedEvent {
  type: 'response.failed'
  sequence_number: number
  response: OpenAIResponse
}

interface ResponseErrorEvent {
  type: 'response.error'
  sequence_number: number
  error: { type: string; message: string }
}

/** Discriminated union of all OpenAI Responses streaming SSE events */
export type OpenAIResponseStreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseOutputItemAddedEvent
  | ResponseContentPartAddedEvent
  | ResponseOutputTextDeltaEvent
  | ResponseOutputTextDoneEvent
  | ResponseContentPartDoneEvent
  | ResponseOutputItemDoneEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseCustomToolCallInputDeltaEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ResponseErrorEvent

/** openai-responses 专属 enrichment，由策略内部计算后传入 renderer。 */
export type ResponsesEnrichment = {
  customToolNames?: Set<string>
  customToolShimmed?: boolean
  toolSearchShimmed?: boolean
  namespaceFlatMap?: NamespaceFlatMap
  /** openai 上游原生支持 namespace：请求侧用 providerOptions.openai.namespace 透传、
   *  响应侧从 providerMetadata.openai.namespace 取，不走 flatten/反查。 */
  namespacePassthrough?: boolean
}
