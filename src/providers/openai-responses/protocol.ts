import { type FilePart, type ToolSet, jsonSchema } from 'ai'
import { openai } from '@ai-sdk/openai'
import type { AISDKInput, ProtocolMessage, ProtocolMessagePart } from '../shared/aisdk-types.js'
import { mapProviderOptions, mapToolToAISDK } from '../shared/protocol-utils.js'
import { isRecord, type NamespaceFlatMap } from '../protocol-types.js'
import { z } from 'zod/v3'

// ─── Schemas ──────────────────────────────────────────────────

const functionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
})

const customToolSchema = z
  .object({
    type: z.literal('custom'),
    name: z.string().min(1),
    description: z.string().optional(),
    format: z
      .union([
        z.object({
          type: z.literal('grammar'),
          syntax: z.enum(['regex', 'lark']),
          definition: z.string(),
        }),
        z.object({ type: z.literal('text') }),
      ])
      .optional(),
  })
  .passthrough()

const webSearchToolSchema = z
  .object({
    type: z.literal('web_search'),
    external_web_access: z.boolean().optional(),
    search_context_size: z.enum(['low', 'medium', 'high']).optional(),
    filters: z
      .object({ allowed_domains: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    user_location: z
      .object({
        type: z.literal('approximate').optional(),
        country: z.string().optional(),
        region: z.string().optional(),
        city: z.string().optional(),
        timezone: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const toolSearchToolSchema = z
  .object({
    type: z.literal('tool_search'),
    execution: z.enum(['server', 'client']).optional(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

const recognizedToolTypes = new Set(['function', 'custom', 'web_search', 'tool_search'])
const unknownToolSchema = z
  .object({ type: z.string() })
  .passthrough()
  .refine((tool) => !recognizedToolTypes.has(tool.type), {
    message: 'recognized tool must match its declared schema',
  })

const requestToolSchema = z.union([
  functionToolSchema,
  customToolSchema,
  webSearchToolSchema,
  toolSearchToolSchema,
  unknownToolSchema,
])

const easyInputMessageSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
})

const agentMessageSchema = z
  .object({
    type: z.literal('agent_message'),
    author: z.string().min(1),
    recipient: z.string().min(1),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  })
  .passthrough()

const functionCallSchema = z.object({
  type: z.literal('function_call'),
  id: z.string().optional(),
  call_id: z.string().min(1),
  name: z.string().min(1),
  namespace: z.string().optional(),
  arguments: z.string(),
})

const functionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
})

// 多轮对话中 Codex 回传的推理项（type: 'reasoning'），含 summary / content /
// encrypted_content。这里先放行，mapping 阶段会在 OpenAI provider path 中
// 通过 providerOptions.openai.reasoningEncryptedContent 透传 encrypted_content。
const reasoningItemSchema = z.object({ type: z.literal('reasoning') }).passthrough()

// custom_tool_call / custom_tool_call_output：Codex apply_patch 等 freeform custom tool 的
// 调用与结果回传（多轮）。input 是裸 patch 文本（非 JSON）。
const customToolCallSchema = z
  .object({
    type: z.literal('custom_tool_call'),
    call_id: z.string().min(1),
    name: z.string().min(1),
    input: z.union([z.string(), z.record(z.string(), z.unknown())]),
  })
  .passthrough()

const customToolCallOutputSchema = z
  .object({
    type: z.literal('custom_tool_call_output'),
    call_id: z.string().min(1),
    output: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  })
  .passthrough()

function hasToolSearchId(value: {
  call_id?: string | undefined
  id?: string | undefined
}): boolean {
  return value.call_id !== undefined || value.id !== undefined
}

const toolSearchCallSchema = z
  .object({
    type: z.literal('tool_search_call'),
    call_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    execution: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .refine(hasToolSearchId, { message: 'tool_search_call requires call_id or id' })

const toolSearchOutputSchema = z
  .object({
    type: z.literal('tool_search_output'),
    call_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()
  .refine(hasToolSearchId, { message: 'tool_search_output requires call_id or id' })

// 多轮对话中 Codex 回传的 hosted web_search 调用项（type: 'web_search_call'）。
// AI SDK 不处理历史 web_search_call input；mapping 阶段跳过。这里放行避免 400。
const webSearchCallInputSchema = z
  .object({
    type: z.literal('web_search_call'),
    id: z.string().optional(),
    status: z.string().optional(),
    action: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

// Codex Desktop can send tool declarations inside input as additional_tools.
// They describe client-side tool availability for the model request envelope; the
// AI SDK mapping path cannot consume them as conversation messages.
const additionalToolsInputSchema = z
  .object({
    type: z.literal('additional_tools'),
    role: z.string().optional(),
    tools: z.array(requestToolSchema).optional(),
  })
  .passthrough()

const inputItemSchema = z.union([
  easyInputMessageSchema,
  functionCallSchema,
  functionCallOutputSchema,
  customToolCallSchema,
  customToolCallOutputSchema,
  toolSearchCallSchema,
  toolSearchOutputSchema,
  webSearchCallInputSchema,
  agentMessageSchema,
  reasoningItemSchema,
  additionalToolsInputSchema,
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
    tools: z.array(requestToolSchema).optional(),
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

type ResponsesTool = NonNullable<OpenAIResponsesRequest['tools']>[number]

function getRequestTools(request: OpenAIResponsesRequest): ResponsesTool[] {
  const tools: ResponsesTool[] = []
  if (request.tools) tools.push(...request.tools)
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (!('type' in item) || item.type !== 'additional_tools') continue
      const additionalTools = (item as { tools?: ResponsesTool[] }).tools
      if (Array.isArray(additionalTools)) tools.push(...additionalTools)
    }
  }
  return tools
}

// ─── Validation ──────────────────────────────────────────────

export function validateOpenAIResponsesRequest(value: unknown): OpenAIResponsesRequest {
  // Codex CLI 发送显式 null 表示"未设置"（与 OpenAI API 语义一致）。
  // zod 的 .optional() 不接受 null，mapping 层的 !== undefined 也不防 null。
  // 在此统一剔除顶层 null 值，使其与 undefined 等价，避免 schema 400 或 mapping 500。
  if (isRecord(value)) {
    const normalized = { ...value }
    for (const key of Object.keys(normalized)) {
      if (normalized[key] === null) delete normalized[key]
    }
    return openAIResponsesRequestSchema.parse(normalized)
  }
  return openAIResponsesRequestSchema.parse(value)
}

/** Collect names of declared custom grammar tools (type:'custom') from the request.
 *  Used by the renderer to discriminate custom_tool_call vs function_call, since
 *  AI SDK @3.0.71 does not expose a toolCallType signal on custom_tool_call parts. */
export function getResponsesCustomToolNames(
  request: OpenAIResponsesRequest,
): Set<string> | undefined {
  const tools = getRequestTools(request)
  if (tools.length === 0) return undefined
  const names = new Set<string>()
  for (const tool of tools) {
    if (tool.type === 'custom') {
      const customTool = tool as { name?: string }
      if (customTool.name) names.add(customTool.name)
    }
  }
  return names.size > 0 ? names : undefined
}

export function hasClientToolSearch(request: OpenAIResponsesRequest): boolean {
  return getRequestTools(request).some(
    (t) => t.type === 'tool_search' && (t as { execution?: string }).execution === 'client',
  )
}

/** tool_search_output / 声明工具集合中 namespace 元素的工具形状（passthrough record 的窄化目标）。 */
type ToolSearchOutputTool = {
  type?: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  tools?: ToolSearchOutputTool[]
}

type DiscoveredToolSearchFunction = {
  name: string
  namespace?: string
  namespaceDescription?: string
  description?: string
  parameters?: Record<string, unknown>
}

/** 把 codex 的 {name, namespace} 还原成 GLM 期望的拍平 toolName。
 *  namespace 存在时 `${namespace}__${name}`，否则原 name。请求侧历史 function_call 映射、
 *  collectNamespaceFlatMap 拍平、toolSet 构建均复用此函数，保证拼接规则一致。 */
function flattenToolName(name: string, namespace: string | undefined): string {
  return namespace ? `${namespace}__${name}` : name
}

function collectDiscoveredToolSearchFunctions(
  request: OpenAIResponsesRequest,
): DiscoveredToolSearchFunction[] {
  const discovered: DiscoveredToolSearchFunction[] = []
  if (!Array.isArray(request.input)) return discovered

  for (const item of request.input) {
    if (!('type' in item) || item.type !== 'tool_search_output') continue
    const tsOut = item as { tools?: ToolSearchOutputTool[] }
    if (!Array.isArray(tsOut.tools)) continue
    for (const tool of tsOut.tools) {
      if (tool.type === 'namespace') {
        if (!tool.name || !Array.isArray(tool.tools)) continue
        for (const sub of tool.tools) {
          if (!sub.name || sub.type !== 'function') continue
          discovered.push({
            name: sub.name,
            namespace: tool.name,
            ...(tool.description !== undefined && { namespaceDescription: tool.description }),
            ...(sub.description !== undefined && { description: sub.description }),
            ...(sub.parameters !== undefined && { parameters: sub.parameters }),
          })
        }
      } else if (tool.type === 'function' && tool.name) {
        discovered.push({
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          ...(tool.parameters !== undefined && { parameters: tool.parameters }),
        })
      }
    }
  }

  return discovered
}

/** 收集 namespace 拍平映射：flatName → {namespace, name}。
 *  来源：(1) 顶层 tools / input.additional_tools 的 namespace 工具；
 *  (2) input 历史的 tool_search_output 里的 namespace/顶层 function。
 *  用于响应侧把 GLM 返回的拍平 toolName 拆回 codex 期望的 {name, namespace} 分离字段。 */
function collectNamespaceFlatMap(request: OpenAIResponsesRequest): NamespaceFlatMap {
  const map: NamespaceFlatMap = new Map()
  const add = (namespace: string | undefined, name: string) => {
    const flatName = flattenToolName(name, namespace)
    if (!map.has(flatName)) map.set(flatName, { namespace, name })
  }

  // (1) 顶层 tools / input.additional_tools 的 namespace
  for (const tool of getRequestTools(request)) {
    if (tool.type !== 'namespace') continue
    const nsTool = tool as ToolSearchOutputTool
    if (!nsTool.name || !Array.isArray(nsTool.tools)) continue
    for (const sub of nsTool.tools) {
      if (!sub.name || sub.type !== 'function') continue
      add(nsTool.name, sub.name)
    }
  }

  for (const tool of collectDiscoveredToolSearchFunctions(request)) {
    add(tool.namespace, tool.name)
  }

  return map
}

/** collectNamespaceFlatMap 的可选包装：无 namespace 工具时返回 undefined（复用 getCustomToolNames 模式）。 */
export function getResponsesNamespaceFlatMap(
  request: OpenAIResponsesRequest,
): NamespaceFlatMap | undefined {
  const map = collectNamespaceFlatMap(request)
  return map.size > 0 ? map : undefined
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

function buildInputImageProviderOptions(
  item: Record<string, unknown>,
  imageUrl: unknown,
): FilePart['providerOptions'] | undefined {
  const detail =
    typeof item.detail === 'string'
      ? item.detail
      : isRecord(imageUrl) && typeof imageUrl.detail === 'string'
        ? imageUrl.detail
        : undefined
  return detail ? { openai: { imageDetail: detail } } : undefined
}

function hasUrlScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
}

function mapInputImageContent(item: Record<string, unknown>): ProtocolMessagePart {
  const imageUrl = item.image_url
  const resolvedUrl =
    typeof imageUrl === 'string'
      ? imageUrl
      : isRecord(imageUrl) && typeof imageUrl.url === 'string'
        ? imageUrl.url
        : typeof item.url === 'string'
          ? item.url
          : undefined
  const providerOptions = buildInputImageProviderOptions(item, imageUrl)
  const withProviderOptions = providerOptions ? { providerOptions } : {}

  if (resolvedUrl) {
    if (resolvedUrl.startsWith('data:')) {
      return {
        type: 'file',
        mediaType: 'image',
        data: resolvedUrl,
        ...withProviderOptions,
      }
    }
    if (hasUrlScheme(resolvedUrl)) {
      return {
        type: 'file',
        mediaType: 'image',
        data: new URL(resolvedUrl),
        ...withProviderOptions,
      }
    }
    return {
      type: 'file',
      mediaType: 'image',
      data: resolvedUrl,
      ...withProviderOptions,
    }
  }

  if (typeof item.file_id === 'string') {
    return {
      type: 'file',
      mediaType: 'image',
      data: item.file_id,
      ...withProviderOptions,
    }
  }

  return { type: 'text', text: '' }
}

function mapEasyInputContent(content: EasyInputContent): string | ProtocolMessagePart[] {
  if (typeof content === 'string') return content
  return content.map((item): ProtocolMessagePart => {
    if (item.type === 'input_text' || item.type === 'output_text') {
      return { type: 'text', text: String(item.text ?? '') }
    }
    if (item.type === 'input_image') {
      return mapInputImageContent(item)
    }
    // Fallback for unrecognized content parts: map to text
    return { type: 'text', text: String(item.text ?? '') }
  })
}

function mapAgentMessageContent(item: z.infer<typeof agentMessageSchema>): ProtocolMessagePart[] {
  const mapped = mapEasyInputContent(item.content)
  const content = typeof mapped === 'string' ? [{ type: 'text' as const, text: mapped }] : mapped
  return [
    {
      type: 'text',
      text: 'Agent message from ' + item.author + ' to ' + item.recipient + ':',
    },
    ...content,
  ]
}

function inferCurrentAgent(input: OpenAIResponsesRequest['input']): string | undefined {
  if (!Array.isArray(input)) return undefined
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if (!item) continue
    if ('type' in item && item.type === 'agent_message') {
      const recipient = (item as z.infer<typeof agentMessageSchema>).recipient
      if (recipient) return recipient
    }
  }
  return undefined
}

// ─── Shim Helpers ────────────────────────────────────────────

function buildShimmedCustomToolDescription(
  description: string | undefined,
  format: unknown,
): string | undefined {
  const parts: string[] = []
  if (description) parts.push(description)
  if (isRecord(format) && format.type === 'grammar') {
    const syntax = typeof format.syntax === 'string' ? format.syntax : 'grammar'
    const definition = typeof format.definition === 'string' ? format.definition : ''
    if (definition) {
      parts.push(`Output must follow this ${syntax} grammar:\n${definition}`)
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function shimCustomToolAsFunction(tool: {
  name?: string
  description?: string
  format?: unknown
}): ToolSet[string] {
  const desc = buildShimmedCustomToolDescription(tool.description, tool.format)
  const def: ToolSet[string] = {
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Raw tool input content (not JSON-wrapped)' },
      },
      required: ['input'],
    }),
  }
  if (desc !== undefined) def.description = desc
  return def
}

function mapNamedFunctionTool(
  name: string,
  source: { description?: string; parameters?: Record<string, unknown> },
): ToolSet[string] {
  return mapResponsesFunctionTool({
    type: 'function',
    name,
    ...(source.description !== undefined && { description: source.description }),
    ...(source.parameters !== undefined && { parameters: source.parameters }),
  })
}

function addSelectableTool(
  toolSet: ToolSet,
  selectableToolNames: Set<string>,
  name: string,
  def: ToolSet[string],
): void {
  if (name in toolSet) {
    throw new Error(`Duplicate tool name '${name}'`)
  }
  toolSet[name] = def
  selectableToolNames.add(name)
}

function addDiscoveredToolSearchOutputTools(input: {
  request: OpenAIResponsesRequest
  toolSet: ToolSet
  selectableToolNames: Set<string>
  nativeResponses: boolean
}): void {
  const { request, toolSet, selectableToolNames, nativeResponses } = input

  for (const discovered of collectDiscoveredToolSearchFunctions(request)) {
    if (discovered.namespace) {
      if (nativeResponses) {
        if (discovered.name in toolSet) continue // 幂等
        const def = mapNamedFunctionTool(discovered.name, discovered)
        def.providerOptions = {
          openai: {
            namespace: {
              name: discovered.namespace,
              ...(discovered.namespaceDescription !== undefined && {
                description: discovered.namespaceDescription,
              }),
            },
          },
        }
        addSelectableTool(toolSet, selectableToolNames, discovered.name, def)
      } else {
        const flatName = flattenToolName(discovered.name, discovered.namespace)
        if (flatName in toolSet) continue // 幂等
        addSelectableTool(
          toolSet,
          selectableToolNames,
          flatName,
          mapNamedFunctionTool(flatName, discovered),
        )
      }
    } else {
      if (discovered.name in toolSet) continue // 幂等
      addSelectableTool(
        toolSet,
        selectableToolNames,
        discovered.name,
        mapNamedFunctionTool(discovered.name, discovered),
      )
    }
  }
}

function buildResponsesToolInput(
  request: OpenAIResponsesRequest,
  providerType?: string,
): Pick<AISDKInput, 'tools' | 'toolChoice'> {
  const nativeResponses = providerType === 'openai'
  const input: Pick<AISDKInput, 'tools' | 'toolChoice'> = {}

  // tools — function tool 直接映射；custom grammar tool（如 apply_patch）仅 openai provider 透传
  // toolSet 提升到 if 外，供下方 tool_choice 校验复用（包含 flattened MCP 工具名）。
  // selectableToolNames 记录可被 tool_choice 选中的 tool（function/custom/flatten），
  // 不含 hosted tool（web_search/tool_search 由 provider 执行，不可 function-select）。
  const toolSet: ToolSet = {}
  const selectableToolNames = new Set<string>()
  const requestTools = getRequestTools(request)
  if (requestTools.length > 0) {
    for (const tool of requestTools) {
      if (tool.type === 'function') {
        const fnTool = tool as ResponsesFunctionTool
        addSelectableTool(
          toolSet,
          selectableToolNames,
          fnTool.name,
          mapResponsesFunctionTool(fnTool),
        )
      } else if (providerType === 'openai' && tool.type === 'custom') {
        // apply_patch 等 custom grammar tool：@ai-sdk/openai customTool 透传（仅 openai provider，
        // openai-compatible 会丢弃 provider tool）。必须保持 type:'custom'，不可降级为 function tool
        // —— Codex 期望 custom_tool_call，function_call 不匹配 ToolPayload::Custom
        const customTool = tool as { name?: string; description?: string; format?: unknown }
        if (customTool.name) {
          const args: Parameters<typeof openai.tools.customTool>[0] = {}
          if (customTool.description !== undefined) args.description = customTool.description
          if (customTool.format !== undefined) {
            args.format = customTool.format as Exclude<
              Parameters<typeof openai.tools.customTool>[0]['format'],
              undefined
            >
          }
          addSelectableTool(
            toolSet,
            selectableToolNames,
            customTool.name,
            openai.tools.customTool(args) as ToolSet[string],
          )
        }
      } else if (providerType !== 'openai' && tool.type === 'custom') {
        const customTool = tool as { name?: string; description?: string; format?: unknown }
        if (customTool.name) {
          addSelectableTool(
            toolSet,
            selectableToolNames,
            customTool.name,
            shimCustomToolAsFunction(customTool),
          )
        }
      } else if (tool.type === 'namespace') {
        // namespace tool：Codex 把 MCP server 的工具包成 {type:'namespace', name, tools:[function...]}。
        // openai 上游原生支持 namespace：子工具用原名注册 + providerOptions.openai.namespace，
        // SDK 自动组装为上游 {type:'namespace', name, tools:[...]}（@ai-sdk/openai@3.0.69+）。
        // 非 openai 上游（Chat Completions/Anthropic 协议无 namespace）：flatten 成顶层 function tool，
        // name 用 mcp__<server>__<tool> 匹配 Codex 扁平回路命名（codex issue #20652）。
        const nsTool = tool as {
          name?: string
          description?: string
          tools?: ResponsesFunctionTool[]
        }
        if (nsTool.name && Array.isArray(nsTool.tools)) {
          for (const subTool of nsTool.tools) {
            // Fix 4: 校验 subTool.name，避免 malformed sub-tool 变成 `mcp__x__undefined`
            if (!subTool.name) continue
            // 只展开 function 子工具；非 function（如 custom）子工具跳过，避免被当 function 注册
            if ((subTool as { type?: string }).type !== 'function') continue
            if (nativeResponses) {
              const def = mapResponsesFunctionTool(subTool)
              def.providerOptions = {
                openai: {
                  namespace: {
                    name: nsTool.name,
                    ...(nsTool.description !== undefined && { description: nsTool.description }),
                  },
                },
              }
              addSelectableTool(toolSet, selectableToolNames, subTool.name, def)
            } else {
              const flatName = flattenToolName(subTool.name, nsTool.name)
              addSelectableTool(
                toolSet,
                selectableToolNames,
                flatName,
                mapResponsesFunctionTool({ ...subTool, name: flatName }),
              )
            }
          }
        }
      } else if (providerType === 'openai' && tool.type === 'web_search') {
        // web_search hosted tool：@ai-sdk/openai webSearch helper 透传（仅 openai provider，
        // openai-compatible 走 Chat Completions 丢弃 hosted tool）。
        // 已知限制：helper schema 不认 search_content_types / index_gated_web_access，被丢弃。
        // filters.allowed_domains → allowedDomains、user_location → userLocation（snake→camel）。
        const wsTool = tool as {
          external_web_access?: boolean
          search_context_size?: 'low' | 'medium' | 'high'
          filters?: { allowed_domains?: string[] }
          user_location?: {
            type?: string
            country?: string
            region?: string
            city?: string
            timezone?: string
          }
        }
        type WebSearchArgs = NonNullable<Parameters<typeof openai.tools.webSearch>[0]>
        const args: WebSearchArgs = {}
        if (wsTool.external_web_access !== undefined)
          args.externalWebAccess = wsTool.external_web_access
        if (wsTool.search_context_size !== undefined)
          args.searchContextSize = wsTool.search_context_size
        if (wsTool.filters !== undefined) {
          const allowedDomains = wsTool.filters.allowed_domains
          const filters: NonNullable<WebSearchArgs['filters']> = {}
          if (allowedDomains !== undefined) filters.allowedDomains = allowedDomains
          args.filters = filters
        }
        if (wsTool.user_location !== undefined) {
          // Codex 发送 user_location（type 通常为 "approximate"）；helper schema 要求 type: "approximate"
          // 字面量。逐字段映射以兼容 exactOptionalPropertyTypes。
          const ul = wsTool.user_location
          const userLocation: NonNullable<WebSearchArgs['userLocation']> = { type: 'approximate' }
          if (ul.country !== undefined) userLocation.country = ul.country
          if (ul.region !== undefined) userLocation.region = ul.region
          if (ul.city !== undefined) userLocation.city = ul.city
          if (ul.timezone !== undefined) userLocation.timezone = ul.timezone
          args.userLocation = userLocation
        }
        toolSet['web_search'] = openai.tools.webSearch(args) as ToolSet[string]
      } else if (providerType === 'openai' && tool.type === 'tool_search') {
        // tool_search hosted tool：@ai-sdk/openai toolSearch helper 透传（仅 openai provider，
        // openai-compatible 走 Chat Completions 丢弃 hosted tool）。
        const tsTool = tool as {
          execution?: string
          description?: string
          parameters?: Record<string, unknown>
        }
        type ToolSearchArgs = NonNullable<Parameters<typeof openai.tools.toolSearch>[0]>
        const args: ToolSearchArgs = {}
        if (tsTool.execution === 'server' || tsTool.execution === 'client')
          args.execution = tsTool.execution
        if (tsTool.description !== undefined) args.description = tsTool.description
        if (tsTool.parameters !== undefined) args.parameters = tsTool.parameters
        toolSet['tool_search'] = openai.tools.toolSearch(args) as ToolSet[string]
      } else if (providerType !== 'openai' && tool.type === 'tool_search') {
        const tsTool = tool as {
          execution?: string
          description?: string
          parameters?: Record<string, unknown>
        }
        if (tsTool.execution === 'client') {
          toolSet['tool_search'] = mapToolToAISDK(
            tsTool.parameters ?? { type: 'object', properties: {} },
            tsTool.description,
          )
          selectableToolNames.add('tool_search')
        }
      }
    }
  }

  // tool_search_output 历史发现的 namespace/顶层 function 工具，拍平加入 toolSet（幂等、追加末尾）。
  // codex 不把 tool_search 动态发现的工具放进顶层 tools[]（依赖 OpenAI 服务端从历史注册），
  // GLM 无此 hosted 机制 → 必须由代理把发现的工具加入 tools[] 才能被调用。幂等保缓存前缀稳定。
  // 注意：此段在 if (request.tools) 块外，确保 request.tools 为 undefined 时仍扫描。
  addDiscoveredToolSearchOutputTools({ request, toolSet, selectableToolNames, nativeResponses })

  // toolSet 赋值（从 if(request.tools) 块内移出，使 tool_search_output 发现的工具能赋给 input.tools）
  const hasBuiltTools = Object.keys(toolSet).length > 0
  if (hasBuiltTools) input.tools = toolSet

  // tool_choice — validate against built toolSet (includes flattened MCP names like
  // mcp__server__tool). Fix 5: 之前只查 request.tools（不含 namespace 内嵌的 flattened 名），
  // 导致 tool_choice 引用 flattened MCP 工具名时静默回退 'auto'。
  // 仅当声明了 tools（toolSet 非空）时才校验；未声明 tools 时直接映射（保留原行为）。
  if (request.tool_choice) {
    if (typeof request.tool_choice === 'object' && hasBuiltTools) {
      const functionName = request.tool_choice.name
      // 只允许选中 function/custom/flatten 工具；hosted tool（web_search/tool_search）
      // 由 provider 执行不可 function-select，引用它们或未知名时回退 'auto'
      if (!selectableToolNames.has(functionName)) {
        input.toolChoice = 'auto'
      } else {
        input.toolChoice = mapResponsesToolChoice(request.tool_choice)
      }
    } else {
      input.toolChoice = mapResponsesToolChoice(request.tool_choice)
    }
  }

  return input
}

function pushToolResultMessage(
  messages: ProtocolMessage[],
  toolCallId: string,
  toolName: string,
  output: unknown,
): void {
  const value = typeof output === 'string' ? output : JSON.stringify(output)
  messages.push({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value },
      },
    ],
  })
}

// ─── Mapping ────────────────────────────────────────────────

const mappedResponsesRequestKeys = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'temperature',
  'top_p',
  'max_output_tokens',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  // 以下字段由显式 camelCase 映射处理（AI SDK zod 只认 camelCase），不从 passthrough 透传
  'reasoning',
  'text',
  'store',
  'prompt_cache_key',
  'client_metadata',
])

export function mapResponsesRequestToAISDKInput(
  request: OpenAIResponsesRequest,
  providerType?: string,
): AISDKInput {
  const messages: ProtocolMessage[] = []
  const systemParts: string[] = []
  // openai 上游原生支持 namespace：namespace 走 providerOptions.openai.namespace 透传（不 flatten），
  // 历史 function_call/custom_tool_call 的 namespace 通过 providerMetadata 携带由 SDK 重建。
  const nativeResponses = providerType === 'openai'
  let hasNativeSystemMessage = false
  let hasNativeDeveloperMessage = false

  // instructions → system option
  if (request.instructions !== undefined && request.instructions !== '') {
    if (!nativeResponses) {
      systemParts.push(request.instructions)
    }
  }

  // input → messages
  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input })
  } else {
    // Build call_id → tool name lookup (function_call_output lacks tool name)
    const callIdToName = new Map<string, string>()
    const currentAgent = inferCurrentAgent(request.input)
    for (const item of request.input) {
      if ('type' in item && item.type === 'function_call') {
        const fc = item as { call_id: string; name: string; namespace?: string }
        callIdToName.set(
          fc.call_id,
          nativeResponses ? fc.name : flattenToolName(fc.name, fc.namespace),
        )
      }
    }

    for (const item of request.input) {
      if ('type' in item && item.type === 'function_call') {
        // function_call → assistant message with tool-call content part
        const fc = item as { call_id: string; name: string; namespace?: string; arguments: string }
        let args: Record<string, unknown> | string = {}
        try {
          args = JSON.parse(fc.arguments)
        } catch {
          args = fc.arguments
        }
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: fc.call_id,
              toolName: nativeResponses ? fc.name : flattenToolName(fc.name, fc.namespace),
              input: args,
              // openai 上游：namespace 由 SDK 从 providerOptions 重建为 function_call.namespace。
              // 必须用 providerOptions（非 providerMetadata）：ai 包 convertToLanguageModelPrompt
              // 只读 part.providerOptions，providerMetadata 会被丢弃（namespace 丢失）。
              ...(nativeResponses && fc.namespace !== undefined
                ? { providerOptions: { openai: { namespace: fc.namespace } } }
                : {}),
            },
          ],
        })
      } else if ('type' in item && item.type === 'function_call_output') {
        pushToolResultMessage(
          messages,
          item.call_id,
          callIdToName.get(item.call_id) ?? item.call_id,
          item.output,
        )
      } else if ('type' in item && item.type === 'custom_tool_call') {
        // custom_tool_call（apply_patch 等 freeform tool 的上轮调用）→ assistant tool-call
        const ctc = item as {
          call_id: string
          name: string
          namespace?: string
          input: string | Record<string, unknown>
        }
        callIdToName.set(
          ctc.call_id,
          nativeResponses ? ctc.name : flattenToolName(ctc.name, ctc.namespace),
        )
        const isShimmed = !nativeResponses
        const rawInput = ctc.input
        const mappedInput =
          isShimmed && typeof rawInput === 'string' ? { input: rawInput } : rawInput
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: ctc.call_id,
              toolName: nativeResponses ? ctc.name : flattenToolName(ctc.name, ctc.namespace),
              input: mappedInput,
              ...(nativeResponses && ctc.namespace !== undefined
                ? { providerOptions: { openai: { namespace: ctc.namespace } } }
                : {}),
            },
          ],
        })
      } else if ('type' in item && item.type === 'custom_tool_call_output') {
        // custom_tool_call_output → tool-result（复用 function_call_output 逻辑）
        pushToolResultMessage(
          messages,
          item.call_id,
          callIdToName.get(item.call_id) ?? item.call_id,
          item.output,
        )
      } else if ('type' in item && item.type === 'tool_search_call') {
        const tsCall = item as {
          call_id?: string
          id?: string
          arguments?: Record<string, unknown>
        }
        const callId = tsCall.call_id ?? tsCall.id ?? ''
        callIdToName.set(callId, 'tool_search')
        const tsInput = tsCall.arguments ?? {}
        messages.push({
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: callId, toolName: 'tool_search', input: tsInput },
          ],
        })
      } else if ('type' in item && item.type === 'tool_search_output') {
        const tsOut = item as { call_id?: string; id?: string; tools?: unknown[] }
        const callId = tsOut.call_id ?? tsOut.id ?? ''
        const toolName = callIdToName.get(callId) ?? 'tool_search'
        pushToolResultMessage(messages, callId, toolName, tsOut.tools ?? [])
      } else if ('type' in item && item.type === 'agent_message') {
        const agentMessage = item as z.infer<typeof agentMessageSchema>
        messages.push({
          role: agentMessage.author === currentAgent ? 'assistant' : 'user',
          content: mapAgentMessageContent(agentMessage),
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
          ? reasoningItem.summary
              .map((s) => s?.text ?? '')
              .filter(Boolean)
              .join('\n')
          : ''
        const reasoningPart: ProtocolMessagePart =
          encryptedContent !== undefined
            ? {
                type: 'reasoning',
                text: summaryText,
                providerOptions: { openai: { reasoningEncryptedContent: encryptedContent } },
              }
            : { type: 'reasoning', text: summaryText }
        messages.push({ role: 'assistant', content: [reasoningPart] })
      } else if ('type' in item && item.type === 'web_search_call') {
        // 历史 hosted web_search 调用：AI SDK 不处理，跳过（不传给上游）。
        // openai 上游走 passthrough 透传原始 body，不走此 map；此处仅 openai-compatible 兜底。
        continue
      } else if ('type' in item && item.type === 'additional_tools') {
        // Codex Desktop 的 input 内工具声明块，不是对话内容；顶层 tools / tool_search_output
        // 才会进入 toolSet 构造。这里跳过，避免把声明块误当 developer message。
        continue
      } else {
        // EasyInputMessage
        const { role, content } = item
        if (role === 'developer' || role === 'system') {
          const text = typeof content === 'string' ? content : extractTextFromContent(content)
          if (text) {
            if (nativeResponses) {
              messages.push({ role: 'system', content: text })
              hasNativeSystemMessage = true
              if (role === 'developer') hasNativeDeveloperMessage = true
            } else {
              systemParts.push(text)
            }
          }
        } else {
          messages.push({ role, content: mapEasyInputContent(content) })
        }
      }
    }
  }

  const input: AISDKInput = { messages }
  if (nativeResponses && hasNativeSystemMessage) {
    input.allowSystemInMessages = true
  }
  if (!nativeResponses && systemParts.length > 0) {
    input.system = systemParts.join('\n')
  }

  if (request.temperature !== undefined) input.temperature = request.temperature
  if (request.top_p !== undefined) input.topP = request.top_p
  if (request.max_output_tokens !== undefined) input.maxOutputTokens = request.max_output_tokens

  Object.assign(input, buildResponsesToolInput(request, providerType))

  // providerOptions key 固定为 "openai"：
  // @ai-sdk/openai 始终读此 key（Responses 模式期望 camelCase 字段）；
  // 其他 provider（如 @ai-sdk/openai-compatible）不认识此 key，自动忽略 → 不泄漏
  const providerOptions = mapProviderOptions(request, mappedResponsesRequestKeys)
  // parallel_tool_calls：AI SDK 期望 parallelToolCalls（camelCase）
  if (request.parallel_tool_calls !== undefined) {
    providerOptions.parallelToolCalls = request.parallel_tool_calls
  }
  // reasoning.effort/summary：AI SDK 期望 reasoningEffort/reasoningSummary（扁平 camelCase），
  // 非 reasoning.effort 嵌套对象（原样透传会被 zod 丢弃）
  if (request.reasoning !== undefined) {
    const reasoning = request.reasoning as { effort?: string; summary?: string }
    if (reasoning.effort !== undefined) providerOptions.reasoningEffort = reasoning.effort
    if (reasoning.summary !== undefined) providerOptions.reasoningSummary = reasoning.summary
  }
  // text.verbosity：AI SDK 期望 textVerbosity
  if (request.text !== undefined) {
    const text = request.text as { verbosity?: string }
    if (text.verbosity !== undefined) providerOptions.textVerbosity = text.verbosity
  }
  // store：字段名恰好匹配 AI SDK 期望（providerOptions.openai.store）
  if (request.store !== undefined) {
    providerOptions.store = request.store
  }
  // prompt_cache_key：AI SDK 期望 promptCacheKey
  if (request.prompt_cache_key !== undefined) {
    providerOptions.promptCacheKey = request.prompt_cache_key
  }
  if (nativeResponses && request.instructions !== undefined && request.instructions !== '') {
    providerOptions.instructions = request.instructions
  }
  if (nativeResponses && hasNativeDeveloperMessage) {
    providerOptions.systemMessageMode = 'developer'
  }
  // client_metadata 是 Codex 客户端侧关联信息；不要转发为上游 metadata。
  if (Object.keys(providerOptions).length > 0) {
    input.providerOptions = { openai: providerOptions }
  }

  return input
}

type ResponsesFunctionTool = Extract<ResponsesTool, { type: 'function' }>

function mapResponsesFunctionTool(tool: ResponsesFunctionTool): ToolSet[string] {
  const def = mapToolToAISDK(
    tool.parameters ?? { type: 'object', properties: {} },
    tool.description,
  ) as ToolSet[string] & { strict?: boolean }
  // 透传 strict：codex 工具显式 strict:false。剥离后部分后端把"无 strict"当作严格模式，
  // 迫使模型为 optional 字段填空字符串（如 spawn_agent 的 reasoning_effort=""），
  // 下游 subagent 请求 reasoning.effort="" 被后端拒绝 → "调不了工具"。
  // AI SDK v4 序列化时 ...tool.strict != null ? { strict: tool.strict } : {}。
  if (tool.strict !== undefined) def.strict = tool.strict
  return def
}

function mapResponsesToolChoice(
  choice: NonNullable<OpenAIResponsesRequest['tool_choice']>,
): NonNullable<AISDKInput['toolChoice']> {
  if (typeof choice === 'string') return choice
  return { type: 'tool', toolName: choice.name }
}
