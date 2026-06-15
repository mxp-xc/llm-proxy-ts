import { jsonSchema, type ToolSet } from 'ai'
import { z } from 'zod/v3'
import type { AISDKInput, ProtocolMessage, ProtocolMessagePart } from '../shared/aisdk-types.js'
import { mapProviderOptions } from '../shared/protocol-utils.js'

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
): AISDKInput {
  const messages: ProtocolMessage[] = []

  // System prompt → AI SDK system 选项（不放入 messages，AI SDK v6 不允许 role: system）
  const systemParts: string[] = []
  if (request.system !== undefined) {
    systemParts.push(
      typeof request.system === 'string'
        ? request.system
        : request.system.map((block) => block.text).join('\n'),
    )
  }

  // 提取 messages 中的 system 角色消息合并到 system
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
    }
  }

  // 构建 tool_use_id → tool name 的查找表（用于补全 tool_result 缺失的 toolName）
  const toolUseIdToName = new Map<string, string>()
  for (const msg of request.messages) {
    if (typeof msg.content !== 'string') {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolUseIdToName.set(block.id, block.name)
        }
      }
    }
  }

  // Anthropic messages → AI SDK messages（user/assistant/tool）
  // Anthropic 协议中 tool_result 在 role:'user' 消息里，
  // 但 AI SDK 要求 tool-result 在 role:'tool' 消息里，因此需要拆分。
  for (const msg of request.messages) {
    if (msg.role !== 'system') {
      messages.push(...mapMessage(msg, toolUseIdToName))
    }
  }

  const input: AISDKInput = { messages }

  if (systemParts.length > 0) {
    input.system = systemParts.join('\n')
  }

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
  // key 固定为 "anthropic"：AI SDK 的 @ai-sdk/anthropic 始终读此 key，
  // 其他 provider（如 @ai-sdk/openai-compatible）不认识此 key，自动忽略 → 不泄漏
  const providerOptions: Record<string, unknown> = {}
  if (request.thinking !== undefined) providerOptions.thinking = request.thinking
  if (request.top_k !== undefined) providerOptions.topK = request.top_k
  if (request.metadata !== undefined) providerOptions.metadata = request.metadata

  // passthrough 字段
  const extraOptions = mapProviderOptions(request, mappedRequestKeys)
  Object.assign(providerOptions, extraOptions)

  if (Object.keys(providerOptions).length > 0) {
    input.providerOptions = { anthropic: providerOptions }
  }

  return input
}

// ─── Internal Helpers ──────────────────────────────────────────

function mapMessage(
  message: z.infer<typeof messageSchema>,
  toolUseIdToName: Map<string, string>,
): ProtocolMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role as 'user' | 'assistant', content: message.content }]
  }

  // 处理 content block 数组
  const textParts: ProtocolMessagePart[] = []
  const toolResultParts: ProtocolMessagePart[] = []
  const toolCallParts: ProtocolMessagePart[] = []

  for (const block of message.content) {
    if (block.type === 'text') {
      textParts.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      toolCallParts.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
      })
    } else if (block.type === 'tool_result') {
      toolResultParts.push({
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        toolName: toolUseIdToName.get(block.tool_use_id) ?? block.tool_use_id,
        output: mapToolResultOutput(block.content, block.is_error),
      })
    }
  }

  // AI SDK 要求 tool-result 必须在 role:'tool' 消息里。
  // 当消息包含 tool_result 时，拆分为 role:'tool' + 原角色两条消息。
  if (toolResultParts.length > 0) {
    const result: ProtocolMessage[] = []
    // tool-result 部分放在 role:'tool' 消息里（排在前面）
    result.push({ role: 'tool', content: toolResultParts })
    // 非 tool-result 部分保留原角色（仅在有内容时）
    const remainingParts = [...textParts, ...toolCallParts]
    if (remainingParts.length > 0) {
      result.push({ role: message.role as 'user' | 'assistant', content: remainingParts })
    }
    return result
  }

  // 无 tool_result 的场景，合并所有部分
  return [{ role: message.role as 'user' | 'assistant', content: [...textParts, ...toolCallParts] }]
}

function mapToolResultOutput(
  content: string | Array<{ type: 'text'; text: string }> | undefined,
  isError?: boolean,
): { type: 'text'; value: string } | { type: 'error-text'; value: string } | { type: 'json'; value: unknown } {
  const outputType = isError ? 'error-text' : 'text'
  if (content === undefined) return { type: outputType, value: '' }
  if (typeof content === 'string') return { type: outputType, value: content }
  // 数组形式的 text blocks → 拼接文本
  const text = content.map((block) => block.text).join('')
  return { type: outputType, value: text }
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