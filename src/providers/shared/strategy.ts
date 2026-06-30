import type { AISDKInput, MappingContext, ProxyStreamPart } from './aisdk-types.js'
import type { SSEOutput } from './sse-utils.js'
import type { NamespaceFlatMap, RenderResultInput } from '../protocol-types.js'
import type { ProtocolErrorFormatter } from './error-format.js'

/**
 * 策略模式接口：封装特定协议的验证、映射、渲染和错误格式化逻辑。
 * 每种协议格式（openai-compatible、openai-responses、anthropic）提供一个实现。
 */
export interface ProtocolStrategy<TRequest = unknown, TSSEData = never, TResult = unknown> {
  /** 验证请求体，无效时抛出 Zod 错误 */
  validate(body: unknown): TRequest
  /** 验证失败时的错误消息（用于 formatErrors.validation） */
  validationMessage?: string
  /** 从已验证的请求中提取模型名（用于路由） */
  getModel(request: TRequest): string
  /** 判断请求是否要求流式响应 */
  isStream(request: TRequest): boolean
  /** 将协议特定请求映射到 AI SDK 输入格式 */
  mapToAISDKInput(request: TRequest, ctx?: MappingContext): AISDKInput
  /** 非流式渲染：将 AI SDK 结果渲染为协议特定响应 */
  renderResult(input: RenderResultInput): TResult
  /** 流式渲染：将 AI SDK 流渲染为结构化 SSE 帧异步迭代。
   *  customToolNames 由 handle-protocol 从请求侧声明的 type:'custom' 工具名收集后传入，
   *  供 openai-responses renderer 判别 custom_tool_call（其他策略忽略此字段）。 */
  renderStreamSSE(input: { model: string; stream: AsyncIterable<ProxyStreamPart>; customToolNames?: Set<string>; customToolShimmed?: boolean; toolSearchShimmed?: boolean; namespaceFlatMap?: NamespaceFlatMap }): AsyncIterable<SSEOutput<TSSEData>>
  /** 错误格式化器：按协议风格格式化各类错误 */
  formatErrors: ProtocolErrorFormatter
  /** 收集请求中声明的 custom grammar tool（type:'custom'）名称集合。
   *  仅 openai-responses 实现；其他策略不实现（返回 undefined）。 */
  getCustomToolNames?(request: TRequest): Set<string> | undefined
  getHasClientToolSearch?(request: TRequest): boolean
  /** 收集 namespace 拍平映射（flatName → {namespace, name}），供 renderer 把 GLM 返回的拍平
   *  toolName 拆回 codex 期望的 {name, namespace} 分离字段。仅 openai-responses 实现。 */
  getNamespaceFlatMap?(request: TRequest): NamespaceFlatMap | undefined
}
