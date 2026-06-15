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
  arguments: string
}

export type ResponseOutputItem = ResponseOutputMessage | ResponseFunctionToolCall

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
  status: 'completed' | 'incomplete'
  output: ResponseOutputItem[]
  output_text: string
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
  arguments: string
}

/** Reasoning item as it appears in streaming output_item events */
interface StreamReasoningItem {
  id: string
  type: 'reasoning'
  summary: ReasoningSummaryItem[]
}

/** Union of all item shapes that can appear in streaming output_item events */
type StreamOutputItem = StreamMessageItem | StreamFunctionCallItem | StreamReasoningItem

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

interface ResponseOutputItemDoneEvent {
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
  | ResponseCompletedEvent
  | ResponseErrorEvent
