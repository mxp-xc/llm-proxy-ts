import { jsonSchema, type ToolSet } from 'ai'
import type { AISDKInput } from './protocol.js'
import { z } from 'zod/v3'

// ─── Schemas ──────────────────────────────────────────────────

const functionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
})

const easyInputMessageSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
})

const functionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
})

const inputItemSchema = z.union([easyInputMessageSchema, functionCallOutputSchema])

export const openAIResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(inputItemSchema)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    tools: z.array(functionToolSchema).optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.object({ type: z.literal('function'), name: z.string().min(1) }),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .passthrough()

export type OpenAIResponsesRequest = z.infer<typeof openAIResponsesRequestSchema>

// ─── Validation ──────────────────────────────────────────────

export function validateOpenAIResponsesRequest(value: unknown): OpenAIResponsesRequest {
  return openAIResponsesRequestSchema.parse(value)
}

// ─── Helpers ────────────────────────────────────────────────

function extractTextFromContent(content: Array<Record<string, unknown>>): string {
  return content
    .filter((item) => item.type === 'input_text' || item.type === 'text')
    .map((item) => String(item.text ?? ''))
    .filter(Boolean)
    .join('\n')
}

function mapEasyInputContent(
  content: string | Array<Record<string, unknown>>,
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  return content.map((item) => {
    if (item.type === 'input_text') {
      return { type: 'text', text: item.text ?? '' }
    }
    if (item.type === 'input_image') {
      return { type: 'image', image: item.image_url ?? item.url ?? item.image }
    }
    return item
  })
}

// ─── Mapping ────────────────────────────────────────────────

const mappedResponsesRequestKeys = new Set([
  'model', 'input', 'instructions', 'stream', 'temperature', 'top_p',
  'max_output_tokens', 'tools', 'tool_choice', 'parallel_tool_calls',
])

export function mapResponsesRequestToAISDKInput(
  request: OpenAIResponsesRequest,
  providerName?: string,
): AISDKInput {
  const messages: Array<Record<string, unknown>> = []
  const systemParts: string[] = []

  // instructions → system option
  if (request.instructions !== undefined && request.instructions !== '') {
    systemParts.push(request.instructions)
  }

  // input → messages
  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input })
  } else {
    for (const item of request.input) {
      if ('type' in item && item.type === 'function_call_output') {
        const output = typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output)
        messages.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: item.call_id,
            // NOTE: Responses API function_call_output does not carry the tool name.
            // Using call_id as toolName fallback — this may cause mismatches if the
            // AI SDK tries to match toolName against the tool definition set.
            toolName: item.call_id,
            output: { type: 'text', value: output },
          }],
        })
      } else {
        // EasyInputMessage
        const { role, content } = item
        if (role === 'developer') {
          const text = typeof content === 'string' ? content : extractTextFromContent(content)
          if (text) systemParts.push(text)
        } else {
          messages.push({ role, content: mapEasyInputContent(content) })
        }
      }
    }
  }

  const input: AISDKInput = { messages }
  if (systemParts.length > 0) {
    input.system = systemParts.join('\n')
  }

  if (request.temperature !== undefined) input.temperature = request.temperature
  if (request.top_p !== undefined) input.topP = request.top_p
  if (request.max_output_tokens !== undefined) input.maxOutputTokens = request.max_output_tokens

  // tools — flat structure → ToolSet
  if (request.tools) {
    const functionTools = request.tools.filter((t) => t.type === 'function')
    if (functionTools.length > 0) {
      input.tools = Object.fromEntries(
        functionTools.map((tool) => [tool.name, mapResponsesFunctionTool(tool)]),
      )
    }
  }

  // tool_choice — validate non-function tool references
  if (request.tool_choice) {
    if (typeof request.tool_choice === 'object' && request.tools) {
      const functionName = request.tool_choice.name
      const isFunctionTool = request.tools.some(
        (t) => t.type === 'function' && t.name === functionName,
      )
      if (!isFunctionTool) {
        // tool_choice references a non-function tool (e.g. web_search_preview)
        // that can't be mapped to AI SDK ToolSet — fall back to 'auto'
        input.toolChoice = 'auto'
      } else {
        input.toolChoice = mapResponsesToolChoice(request.tool_choice)
      }
    } else {
      input.toolChoice = mapResponsesToolChoice(request.tool_choice)
    }
  }

  // provider options passthrough
  if (providerName) {
    const providerOptions = mapResponsesProviderOptions(request)
    if (Object.keys(providerOptions).length > 0) {
      input.providerOptions = { [providerName]: providerOptions }
    }
  }

  return input
}

function mapResponsesFunctionTool(
  tool: Extract<NonNullable<OpenAIResponsesRequest['tools']>[number], { type: 'function' }>,
): ToolSet[string] {
  const definition: ToolSet[string] = {
    inputSchema: jsonSchema(tool.parameters ?? { type: 'object', properties: {} }),
  }
  if (tool.description !== undefined) {
    definition.description = tool.description
  }
  return definition
}

function mapResponsesToolChoice(
  choice: NonNullable<OpenAIResponsesRequest['tool_choice']>,
): NonNullable<AISDKInput['toolChoice']> {
  if (typeof choice === 'string') return choice
  return { type: 'tool', toolName: choice.name }
}

function mapResponsesProviderOptions(
  request: OpenAIResponsesRequest,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => !mappedResponsesRequestKeys.has(key)),
  )
}
