import { type ToolSet } from 'ai'
import { openai } from '@ai-sdk/openai'
import type { AISDKInput, MappingContext, ProtocolMessage, ProtocolMessagePart } from '../shared/aisdk-types.js'
import { mapProviderOptions, mapToolToAISDK } from '../shared/protocol-utils.js'
import { isRecord } from '../protocol-types.js'
import { z } from 'zod/v3'

// ─── Schemas ──────────────────────────────────────────────────

const functionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
})

// Codex 与 OpenAI Responses 会携带非 function 工具（web_search、file_search、
// apply_patch(custom)、namespace、tool_search 等）。AI SDK 仅支持 function 工具，
// 这些工具在 mapping 阶段被 filter 掉；这里只做最小形状校验后原样放行，
// 避免任一非 function 工具导致整包 tools 校验失败（400）。
const passthroughToolSchema = z.object({ type: z.string() }).passthrough()

const easyInputMessageSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
})

const functionCallSchema = z.object({
  type: z.literal('function_call'),
  id: z.string().optional(),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
})

const functionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
})

// 多轮对话中 Codex 回传的推理项（type: 'reasoning'），含 summary / content /
// encrypted_content。AI SDK 不支持 OpenAI 加密推理透传，mapping 阶段跳过；
// 这里先放行，避免 input 校验失败（400）。
const reasoningItemSchema = z.object({ type: z.literal('reasoning') }).passthrough()

// custom_tool_call / custom_tool_call_output：Codex apply_patch 等 freeform custom tool 的
// 调用与结果回传（多轮）。input 是裸 patch 文本（非 JSON）。
const customToolCallSchema = z.object({
  type: z.literal('custom_tool_call'),
  call_id: z.string().min(1),
  name: z.string().min(1),
  input: z.union([z.string(), z.record(z.string(), z.unknown())]),
}).passthrough()

const customToolCallOutputSchema = z.object({
  type: z.literal('custom_tool_call_output'),
  call_id: z.string().min(1),
  output: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
}).passthrough()

const inputItemSchema = z.union([
  easyInputMessageSchema,
  functionCallSchema,
  functionCallOutputSchema,
  customToolCallSchema,
  customToolCallOutputSchema,
  reasoningItemSchema,
])

export const openAIResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(inputItemSchema)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    tools: z.array(z.union([functionToolSchema, passthroughToolSchema])).optional(),
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

type EasyInputContent = z.infer<typeof easyInputMessageSchema>['content']

function extractTextFromContent(content: EasyInputContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((item) => item.type === 'input_text' || item.type === 'text')
    .map((item) => String(item.text ?? ''))
    .filter(Boolean)
    .join('\n')
}

function mapEasyInputContent(
  content: EasyInputContent,
): string | ProtocolMessagePart[] {
  if (typeof content === 'string') return content
  return content.map((item): ProtocolMessagePart => {
    if (item.type === 'input_text' || item.type === 'output_text') {
      return { type: 'text', text: String(item.text ?? '') }
    }
    // input_image: ProtocolMessagePart has no image variant.
    // image_url is mapped to a text placeholder as a known limitation —
    // multimodal content is not fully supported through the gateway yet.
    if (item.type === 'input_image') {
      const imageUrl = item.image_url
      const resolved = typeof imageUrl === 'string'
        ? imageUrl
        : isRecord(imageUrl) && typeof imageUrl.url === 'string'
          ? imageUrl.url as string
          : typeof item.url === 'string' ? item.url : ''
      return { type: 'text', text: resolved }
    }
    // Fallback for unrecognized content parts: map to text
    return { type: 'text', text: String(item.text ?? '') }
  })
}

// ─── Mapping ────────────────────────────────────────────────

const mappedResponsesRequestKeys = new Set([
  'model', 'input', 'instructions', 'stream', 'temperature', 'top_p',
  'max_output_tokens', 'tools', 'tool_choice', 'parallel_tool_calls',
])

export function mapResponsesRequestToAISDKInput(
  request: OpenAIResponsesRequest,
  ctx?: MappingContext,
): AISDKInput {
  const messages: ProtocolMessage[] = []
  const systemParts: string[] = []

  // instructions → system option
  if (request.instructions !== undefined && request.instructions !== '') {
    systemParts.push(request.instructions)
  }

  // input → messages
  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input })
  } else {
    // Build call_id → tool name lookup (function_call_output lacks tool name)
    const callIdToName = new Map<string, string>()
    for (const item of request.input) {
      if ('type' in item && item.type === 'function_call') {
        callIdToName.set(item.call_id, item.name)
      }
    }

    for (const item of request.input) {
      if ('type' in item && item.type === 'function_call') {
        // function_call → assistant message with tool-call content part
        let args: Record<string, unknown> | string = {}
        try {
          args = JSON.parse(item.arguments)
        } catch {
          args = item.arguments
        }
        messages.push({
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: item.call_id,
            toolName: item.name,
            input: args,
          }],
        })
      } else if ('type' in item && item.type === 'function_call_output') {
        const output = typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output)
        messages.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: item.call_id,
            toolName: callIdToName.get(item.call_id) ?? item.call_id,
            output: { type: 'text', value: output },
          }],
        })
      } else if ('type' in item && item.type === 'custom_tool_call') {
        // custom_tool_call（apply_patch 等 freeform tool 的上轮调用）→ assistant tool-call
        callIdToName.set(item.call_id, item.name)
        messages.push({
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: item.call_id,
            toolName: item.name,
            input: item.input,
          }],
        })
      } else if ('type' in item && item.type === 'custom_tool_call_output') {
        // custom_tool_call_output → tool-result（复用 function_call_output 逻辑）
        const output = typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output)
        messages.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: item.call_id,
            toolName: callIdToName.get(item.call_id) ?? item.call_id,
            output: { type: 'text', value: output },
          }],
        })
      } else if ('type' in item && item.type === 'reasoning') {
        // reasoning item：多轮对话回传的推理项。@ai-sdk/openai@3.0.71 支持 encrypted_content
        // 透传；@ai-sdk/openai-compatible 把 reasoning part 的 text 转成 Chat Completions 的
        // reasoning_content 文本（已验证 openai-compatible index.mjs:215-217,245）。
        //   - openai provider：encrypted_content 透传给上游维持推理上下文；为 null 时 SDK 过滤
        //   - openai-compatible provider：providerOptions 被忽略，summary 文本降级为 reasoning_content
        const reasoningItem = item as {
          type: 'reasoning'
          encrypted_content?: string | null
          summary?: Array<{ type: string; text: string }>
        }
        const encryptedContent = reasoningItem.encrypted_content ?? undefined
        const summaryText = Array.isArray(reasoningItem.summary)
          ? reasoningItem.summary.map((s) => s?.text ?? '').filter(Boolean).join('\n')
          : ''
        const reasoningPart: ProtocolMessagePart = encryptedContent !== undefined
          ? { type: 'reasoning', text: summaryText, providerOptions: { openai: { reasoningEncryptedContent: encryptedContent } } }
          : { type: 'reasoning', text: summaryText }
        messages.push({ role: 'assistant', content: [reasoningPart] })
      } else {
        // EasyInputMessage
        const { role, content } = item
        if (role === 'developer' || role === 'system') {
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

  // tools — function tool 直接映射；custom grammar tool（如 apply_patch）仅 openai provider 透传
  if (request.tools) {
    const toolSet: ToolSet = {}
    for (const tool of request.tools) {
      if (tool.type === 'function') {
        const fnTool = tool as ResponsesFunctionTool
        toolSet[fnTool.name] = mapResponsesFunctionTool(fnTool)
      } else if (ctx?.providerType === 'openai' && tool.type === 'custom') {
        // apply_patch 等 custom grammar tool：@ai-sdk/openai customTool 透传（仅 openai provider，
        // openai-compatible 会丢弃 provider tool）。必须保持 type:'custom'，不可降级为 function tool
        // —— Codex 期望 custom_tool_call，function_call 不匹配 ToolPayload::Custom
        const customTool = tool as { name?: string; description?: string; format?: unknown }
        if (customTool.name) {
          const args: Parameters<typeof openai.tools.customTool>[0] = { name: customTool.name }
          if (customTool.description !== undefined) args.description = customTool.description
          if (customTool.format !== undefined) {
            args.format = customTool.format as Exclude<Parameters<typeof openai.tools.customTool>[0]['format'], undefined>
          }
          toolSet[customTool.name] = openai.tools.customTool(args) as ToolSet[string]
        }
      }
      // 其他非 function tool（web_search/namespace/tool_search）：v0 跳过
    }
    if (Object.keys(toolSet).length > 0) input.tools = toolSet
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

  // providerOptions key 固定为 "openai"：
  // @ai-sdk/openai 始终读此 key，passthrough 正常工作；
  // 其他 provider（如 @ai-sdk/openai-compatible）不认识此 key，自动忽略 → 不泄漏
  const providerOptions = mapProviderOptions(request, mappedResponsesRequestKeys)
  // parallel_tool_calls 在 mappedResponsesRequestKeys 中被排除（不走 passthrough），
  // 但 @ai-sdk/openai 期望 providerOptions.openai.parallelToolCalls（camelCase）
  if (request.parallel_tool_calls !== undefined) {
    providerOptions.parallelToolCalls = request.parallel_tool_calls
  }
  if (Object.keys(providerOptions).length > 0) {
    input.providerOptions = { openai: providerOptions }
  }

  return input
}

type ResponsesFunctionTool = Extract<NonNullable<OpenAIResponsesRequest['tools']>[number], { type: 'function' }>

function mapResponsesFunctionTool(tool: ResponsesFunctionTool): ToolSet[string] {
  return mapToolToAISDK(tool.parameters ?? { type: 'object', properties: {} }, tool.description)
}

function mapResponsesToolChoice(
  choice: NonNullable<OpenAIResponsesRequest['tool_choice']>,
): NonNullable<AISDKInput['toolChoice']> {
  if (typeof choice === 'string') return choice
  return { type: 'tool', toolName: choice.name }
}
