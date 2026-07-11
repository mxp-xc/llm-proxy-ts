import type { AISDKInput, ProxyStreamPart } from './aisdk-types.js'
import type { SSEOutput } from './sse-utils.js'
import type { RenderResultInput } from '../protocol-types.js'
import type { ProtocolErrorFormatter } from './error-format.js'
import type { RouteMatch } from '../../routing.js'
import type { Settings } from '../../config.js'
import type { ProviderPassthroughTransport } from '../registry.js'
import type { Logger } from '../../types.js'

/** passthrough 直通转发入参：原生协议 + 原生上游时，请求响应绕过 AI SDK 直接转发。
 *  仅 openai-responses + openai 上游启用；其余协议/上游不实现 passthrough（回退 AI SDK 路径）。 */
export interface PassthroughInput<TRequest> {
  /** 路由匹配结果：provider 配置、upstreamModel、headers */
  route: RouteMatch
  /** validate 后的请求（schema passthrough，保留顶层未知字段；仅用于辅助判断） */
  request: TRequest
  /** 原始请求 JSON（未经 Zod 解析）：透传 body 用此副本替换 model，保证字节级一致 */
  rawBody: unknown
  /** 后端真实 model 名（替换 rawBody.model） */
  upstreamModel: string
  /** OAuth login URL 由 server module 计算，provider adapter 只负责格式化错误。 */
  loginUrl: string
  settings: Settings
  /** 获取 passthrough 上游 fetch + auth/proxy transport。 */
  passthroughTransport: (providerName: string) => ProviderPassthroughTransport
  /** 写请求级 keySelection 元数据，由 server module 决定落点。 */
  setKeySelection: (keySelection: NonNullable<ProviderPassthroughTransport['keySelection']>) => void
  logger: Logger
  abortController: AbortController
}

/**
 * 策略模式接口：封装特定协议的验证、映射、渲染和错误格式化逻辑。
 * 每种协议格式（openai-compatible、openai-responses、anthropic）提供一个实现。
 */
export interface ProtocolStrategy<
  TRequest = unknown,
  TSSEData = never,
  TResult = unknown,
  TEnrichment extends object = Record<never, never>,
> {
  /** 验证请求体，无效时抛出 Zod 错误 */
  validate(body: unknown): TRequest
  /** 验证失败时的错误消息（用于 formatErrors.validation） */
  validationMessage?: string
  /** 从已验证的请求中提取模型名（用于路由） */
  getModel(request: TRequest): string
  /** 判断请求是否要求流式响应 */
  isStream(request: TRequest): boolean
  /** 将协议特定请求映射到 AI SDK 输入格式 */
  mapToAISDKInput(request: TRequest, providerType?: string): AISDKInput
  /** 非流式渲染：将 AI SDK 结果渲染为协议特定响应 */
  renderResult(input: RenderResultInput & TEnrichment): TResult
  /** 流式渲染：将 AI SDK 流渲染为结构化 SSE 帧异步迭代。
   *  额外字段由 prepareEnrichment 计算后原样透传（仅 openai-responses 使用）。 */
  renderStreamSSE(
    input: {
      model: string
      stream: AsyncIterable<ProxyStreamPart>
    } & TEnrichment,
  ): AsyncIterable<SSEOutput<TSSEData>>
  /** 错误格式化器：按协议风格格式化各类错误 */
  formatErrors: ProtocolErrorFormatter
}

export interface ProtocolRenderEnrichment<TRequest, TEnrichment extends object> {
  /** 策略专属的请求侧 enrichment 计算；返回的不透明对象由编排器原样透传给 renderer。 */
  prepareEnrichment(request: TRequest, providerType: string): TEnrichment | undefined
}

export interface ProtocolPassthroughCapability<TRequest> {
  /** passthrough 直通转发：返回 Response 表示已透传；undefined 表示回退 AI SDK 路径。 */
  passthrough(input: PassthroughInput<TRequest>): Promise<Response | undefined>
}
