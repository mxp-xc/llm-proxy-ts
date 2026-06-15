export interface ResponseOutputText {
  type: 'output_text'
  text: string
  annotations: unknown[]
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
  tools: unknown[]
  parallel_tool_calls: boolean
  truncation: 'disabled'
}
