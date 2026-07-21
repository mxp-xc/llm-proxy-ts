import { type ToolSet } from 'ai'
import { z } from 'zod/v3'
import type { AISDKInput, ProtocolMessage, ProtocolMessagePart } from '../shared/aisdk-types.js'
import { isRecord } from '../protocol-types.js'
import { mapProviderOptions, mapToolToAISDK } from '../shared/protocol-utils.js'

export type { AISDKInput } from '../shared/aisdk-types.js'

const openAIToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().optional(),
  }),
})

const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).nullish(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(openAIToolCallSchema).optional(),
  })
  .superRefine((message, ctx) => {
    if (message.role === 'tool' && !message.tool_call_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tool_call_id'],
        message: 'tool_call_id is required for tool messages',
      })
    }
    if (message.role === 'tool' && message.content == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'content is required for tool messages',
      })
    }
    if (message.role === 'assistant' && message.content == null && !message.tool_calls?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'assistant content is required without tool_calls',
      })
    }
  })

const functionToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  }),
})

export const openAIChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    tools: z.array(functionToolSchema).optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) }),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .passthrough()

export type OpenAIChatRequest = z.infer<typeof openAIChatRequestSchema>

const mappedRequestKeys = new Set([
  'model',
  'messages',
  'stream',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
])

export function validateOpenAIChatRequest(value: unknown): OpenAIChatRequest {
  return openAIChatRequestSchema.parse(value)
}

export function mapOpenAIChatRequestToAISDKInput(request: OpenAIChatRequest): AISDKInput {
  // System prompt → AI SDK system 选项（不放入 messages，避免 AI SDK v4+ 警告）
  const systemParts: string[] = []
  for (const msg of request.messages) {
    if (msg.role === 'system') {
      const text = extractSystemText(msg.content)
      if (text) systemParts.push(text)
    }
  }

  // Build tool_call_id → tool name lookup (for tool-result messages that lack the tool name)
  const toolCallIdToName = new Map<string, string>()
  for (const msg of request.messages) {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        toolCallIdToName.set(tc.id, tc.function.name)
      }
    }
  }

  const input: AISDKInput = {
    messages: request.messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => mapMessage(msg, toolCallIdToName)),
  }

  if (systemParts.length > 0) {
    input.system = systemParts.join('\n')
  }

  if (request.temperature !== undefined) input.temperature = request.temperature
  if (request.top_p !== undefined) input.topP = request.top_p
  if (request.presence_penalty !== undefined) input.presencePenalty = request.presence_penalty
  if (request.frequency_penalty !== undefined) input.frequencyPenalty = request.frequency_penalty
  if (request.max_completion_tokens !== undefined)
    input.maxOutputTokens = request.max_completion_tokens
  else if (request.max_tokens !== undefined) input.maxOutputTokens = request.max_tokens
  if (request.stop !== undefined)
    input.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop]
  if (request.tools)
    input.tools = Object.fromEntries(
      request.tools.map((tool) => [tool.function.name, mapFunctionTool(tool)]),
    )
  if (request.tool_choice) {
    input.toolChoice = mapToolChoice(request.tool_choice)
  }
  // providerOptions key 固定为 "openaiCompatible"：
  // @ai-sdk/openai-compatible 的 4 级 fallback 包含此 key，passthrough 正常工作；
  // 其他 provider（如 @ai-sdk/anthropic）不认识此 key，自动忽略 → 不泄漏
  const providerOptions = mapProviderOptions(request, mappedRequestKeys)
  // parallel_tool_calls: AI SDK openai-compatible 不原生支持，通过 providerOptions 透传
  if (request.parallel_tool_calls !== undefined)
    providerOptions.parallel_tool_calls = request.parallel_tool_calls
  if (Object.keys(providerOptions).length > 0) {
    input.providerOptions = { openaiCompatible: providerOptions }
  }

  // 同时设置 providerOptions.openai 以支持跨路由兼容：
  // 当 /v1/chat/completions 请求路由到 openai-type provider 时，
  // @ai-sdk/openai 读 providerOptions.openai（而非 openaiCompatible）。
  // 仅包含显式映射的 camelCase 字段，因为 @ai-sdk/openai 会 schema 校验并剥离未知 key。
  const openaiOptions: Record<string, unknown> = {}
  if (request.parallel_tool_calls !== undefined) {
    openaiOptions.parallelToolCalls = request.parallel_tool_calls
  }
  if (Object.keys(openaiOptions).length > 0) {
    if (input.providerOptions) {
      input.providerOptions.openai = openaiOptions
    } else {
      input.providerOptions = { openai: openaiOptions }
    }
  }

  return input
}

function mapMessage(
  message: z.infer<typeof messageSchema>,
  toolCallIdToName: Map<string, string>,
): ProtocolMessage {
  if (message.role === 'assistant' && message.tool_calls?.length) {
    const content: ProtocolMessagePart[] = message.tool_calls.map((toolCall) => ({
      type: 'tool-call' as const,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      input: parseToolCallInput(toolCall.function.arguments),
    }))
    if (typeof message.content === 'string' && message.content.length > 0) {
      content.unshift({ type: 'text', text: message.content })
    }

    return {
      role: 'assistant',
      content,
    }
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: message.tool_call_id ?? 'tool',
          toolName:
            toolCallIdToName.get(message.tool_call_id ?? '') ?? message.tool_call_id ?? 'tool',
          output: mapToolResultOutput(message.content),
        },
      ],
    }
  }

  if (message.role === 'user' && Array.isArray(message.content)) {
    return {
      role: 'user',
      content: message.content.map(mapUserContentPart),
    }
  }

  // user or assistant messages: content is string | content-part array | undefined
  const content = message.content ?? ''
  return { role: message.role as 'user' | 'assistant', content } as ProtocolMessage
}

type MessageContent = z.infer<typeof messageSchema>['content']

function mapUserContentPart(part: Record<string, unknown>): ProtocolMessagePart {
  if (part.type !== 'image_url' || !isRecord(part.image_url)) {
    return part as ProtocolMessagePart
  }

  const imageUrl = part.image_url
  if (typeof imageUrl.url !== 'string') {
    return part as ProtocolMessagePart
  }

  const isDataUrl = /^data:/i.test(imageUrl.url)
  const isRemoteUrl = /^https?:\/\//i.test(imageUrl.url) && URL.canParse(imageUrl.url)
  if (!isDataUrl && !isRemoteUrl) {
    return part as ProtocolMessagePart
  }

  const detail = typeof imageUrl.detail === 'string' ? imageUrl.detail : undefined
  return {
    type: 'file',
    mediaType: 'image',
    data: isDataUrl ? imageUrl.url : new URL(imageUrl.url),
    ...(detail
      ? {
          providerOptions: {
            openai: { imageDetail: detail },
            openaiCompatible: { imageDetail: detail },
          },
        }
      : {}),
  }
}

function extractSystemText(content: MessageContent): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: string; text?: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part.type === 'text' || part.type === undefined) &&
          typeof part.text === 'string',
      )
      .map((part) => part.text)
      .join('\n')
  }
  if (content == null) return ''
  return String(content)
}

function parseToolCallInput(value: string | undefined): Record<string, unknown> | string {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : value
  } catch {
    return value
  }
}

function mapToolResultOutput(
  content: MessageContent,
): { type: 'text'; value: string } | { type: 'json'; value: unknown } {
  if (typeof content === 'string') {
    return { type: 'text', value: content }
  }
  return { type: 'json', value: content }
}

function mapFunctionTool(tool: z.infer<typeof functionToolSchema>): ToolSet[string] {
  return mapToolToAISDK(tool.function.parameters, tool.function.description)
}

function mapToolChoice(
  choice: NonNullable<OpenAIChatRequest['tool_choice']>,
): NonNullable<AISDKInput['toolChoice']> {
  if (typeof choice === 'string') return choice
  return { type: 'tool', toolName: choice.function.name }
}
