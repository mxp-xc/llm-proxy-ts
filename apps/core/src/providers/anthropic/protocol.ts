import { jsonSchema, type ToolSet } from 'ai'
import { z } from 'zod/v3'
import type { AISDKInput } from '../openai/protocol.js'

// ─── Content Block Schemas ─────────────────────────────────────

const cacheControlSchema = z.object({
  type: z.literal('ephemeral'),
  ttl: z.enum(['5m', '1h']).optional(),
})

const textContentBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: cacheControlSchema.optional(),
})

const toolUseContentBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
})

const toolResultContentBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(textContentBlockSchema)]).optional(),
  is_error: z.boolean().optional(),
  cache_control: cacheControlSchema.optional(),
})

const contentBlockSchema = z.union([
  textContentBlockSchema,
  toolUseContentBlockSchema,
  toolResultContentBlockSchema,
])

// ─── System Schema ─────────────────────────────────────────────

const systemTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: cacheControlSchema.optional(),
})

// ─── Message Schema ────────────────────────────────────────────

const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
})

// ─── Tool Schema ───────────────────────────────────────────────

const anthropicToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  cache_control: cacheControlSchema.optional(),
  type: z.literal('custom').optional(),
})

// ─── Tool Choice Schema ────────────────────────────────────────

const toolChoiceSchema = z.union([
  z.object({ type: z.literal('auto'), disable_parallel_tool_use: z.boolean().optional() }),
  z.object({ type: z.literal('any'), disable_parallel_tool_use: z.boolean().optional() }),
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('tool'),
    name: z.string().min(1),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
])

// ─── Thinking Schema ───────────────────────────────────────────

const thinkingSchema = z.union([
  z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().min(1024), display: z.enum(['summarized', 'omitted']).optional() }),
  z.object({ type: z.literal('adaptive'), display: z.enum(['summarized', 'omitted']).optional() }),
  z.object({ type: z.literal('disabled') }),
])

// ─── Request Schema ────────────────────────────────────────────

export const anthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    max_tokens: z.number().int().positive(),
    system: z.union([z.string(), z.array(systemTextBlockSchema)]).optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().int().positive().optional(),
    stop_sequences: z.array(z.string()).optional(),
    tools: z.array(anthropicToolSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    metadata: z.object({ user_id: z.union([z.string(), z.null()]).optional() }).optional(),
    thinking: thinkingSchema.optional(),
  })
  .passthrough()

export type AnthropicMessagesRequest = z.infer<typeof anthropicMessagesRequestSchema>

// ─── Validation ────────────────────────────────────────────────

export function validateAnthropicMessagesRequest(value: unknown): AnthropicMessagesRequest {
  return anthropicMessagesRequestSchema.parse(value)
}

// ─── Mapping ───────────────────────────────────────────────────

const mappedRequestKeys = new Set([
  'model',
  'messages',
  'max_tokens',
  'system',
  'stream',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'tools',
  'tool_choice',
  'metadata',
  'thinking',
])

export function mapAnthropicMessagesRequestToAISDKInput(
  request: AnthropicMessagesRequest,
  providerName?: string,
): AISDKInput {
  const messages: Array<Record<string, unknown>> = []

  // System prompt → 前置 system message
  const systemParts: string[] = []
  if (request.system !== undefined) {
    systemParts.push(
      typeof request.system === 'string'
        ? request.system
        : request.system.map((block) => block.text).join('\n'),
    )
  }

  // Anthropic messages → AI SDK messages（提取 system 角色消息合并到 system）
  for (const msg of request.messages) {
    if (msg.role === 'system') {
      systemParts.push(
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n'),
      )
    } else {
      messages.push(mapMessage(msg))
    }
  }

  if (systemParts.length > 0) {
    messages.unshift({ role: 'system', content: systemParts.join('\n') })
  }

  const input: AISDKInput = { messages }

  if (request.temperature !== undefined) input.temperature = request.temperature
  if (request.top_p !== undefined) input.topP = request.top_p
  if (request.max_tokens !== undefined) input.maxOutputTokens = request.max_tokens
  if (request.stop_sequences !== undefined) input.stopSequences = request.stop_sequences

  if (request.tools) {
    input.tools = Object.fromEntries(
      request.tools.map((tool) => [tool.name, mapAnthropicTool(tool)]),
    )
  }

  if (request.tool_choice) {
    input.toolChoice = mapToolChoice(request.tool_choice)
  }

  // Anthropic 特有字段 → providerOptions.anthropic
  if (providerName) {
    const providerOptions: Record<string, unknown> = {}
    if (request.thinking !== undefined) providerOptions.thinking = request.thinking
    if (request.top_k !== undefined) providerOptions.topK = request.top_k
    if (request.metadata !== undefined) providerOptions.metadata = request.metadata
    if (request.stop_sequences !== undefined)
      providerOptions.stop_sequences = request.stop_sequences

    // passthrough 字段
    const extraOptions = mapProviderOptions(request)
    Object.assign(providerOptions, extraOptions)

    if (Object.keys(providerOptions).length > 0) {
      input.providerOptions = { [providerName]: providerOptions }
    }
  }

  return input
}

// ─── Internal Helpers ──────────────────────────────────────────

function mapMessage(message: z.infer<typeof messageSchema>): Record<string, unknown> {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content }
  }

  // 处理 content block 数组
  const content: Array<Record<string, unknown>> = []

  for (const block of message.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
      })
    } else if (block.type === 'tool_result') {
      content.push({
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        toolName: block.tool_use_id,
        output: mapToolResultOutput(block.content),
      })
    }
  }

  return { role: message.role, content }
}

function mapToolResultOutput(
  content: string | Array<{ type: 'text'; text: string }> | undefined,
): { type: 'text'; value: string } | { type: 'json'; value: unknown } {
  if (content === undefined) return { type: 'text', value: '' }
  if (typeof content === 'string') return { type: 'text', value: content }
  // 数组形式的 text blocks → 拼接文本
  const text = content.map((block) => block.text).join('')
  return { type: 'text', value: text }
}

function mapAnthropicTool(tool: z.infer<typeof anthropicToolSchema>): ToolSet[string] {
  const definition: ToolSet[string] = {
    inputSchema: jsonSchema(tool.input_schema),
  }
  if (tool.description !== undefined) {
    definition.description = tool.description
  }
  return definition
}

function mapToolChoice(
  choice: NonNullable<AnthropicMessagesRequest['tool_choice']>,
): NonNullable<AISDKInput['toolChoice']> {
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  // { type: 'tool', name } → { type: 'tool', toolName }
  return { type: 'tool', toolName: choice.name }
}

function mapProviderOptions(request: AnthropicMessagesRequest): Record<string, unknown> {
  return Object.fromEntries(Object.entries(request).filter(([key]) => !mappedRequestKeys.has(key)))
}
