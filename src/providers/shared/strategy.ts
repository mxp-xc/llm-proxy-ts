import type { Context } from 'hono'
import type { AISDKInput, ProxyStreamPart } from './aisdk-types.js'
import type { SSEOutput } from './sse-utils.js'
import type { RenderResultInput } from '../protocol-types.js'
import type { ProtocolErrorFormatter } from './error-format.js'
import type { AppEnv } from '../../server/types.js'
import type { RouteMatch } from '../../routing.js'
import type { Settings } from '../../config.js'
import type { KeySelection } from '../registry.js'

/** passthrough 直通转发入参：原生协议 + 原生上游时，请求响应绕过 AI SDK 直接转发。
 *  仅 openai-responses + openai 上游启用；其余协议/上游不实现 passthrough（回退 AI SDK 路径）。 */
export interface PassthroughInput<TRequest> {
  /** Hono 请求上下文：取请求头、写 keySelection/日志变量 */
  c: Context<AppEnv>
  /** 路由匹配结果：provider 配置、upstreamModel、headers */
  route: RouteMatch
  /** validate 后的请求（schema passthrough，保留顶层未知字段；仅用于辅助判断） */
  request: TRequest
  /** 原始请求 JSON（未经 Zod 解析）：透传 body 用此副本替换 model，保证字节级一致 */
  rawBody: unknown
  /** 后端真实 model 名（替换 rawBody.model） */
  upstreamModel: string
  settings: Settings
  /** 选 API key（复用 registry 轮询状态），注入 Authorization */
  selectApiKey: (
    providerName: string,
  ) => { apiKey: string | undefined; keySelection?: KeySelection }
  abortController: AbortController
}

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
  mapToAISDKInput(request: TRequest, providerType?: string): AISDKInput
  /** 非流式渲染：将 AI SDK 结果渲染为协议特定响应 */
  renderResult(input: RenderResultInput): TResult
  /** 流式渲染：将 AI SDK 流渲染为结构化 SSE 帧异步迭代。
   *  额外字段由 prepareEnrichment 计算后原样透传（仅 openai-responses 使用）。 */
  renderStreamSSE(
    input: {
      model: string
      stream: AsyncIterable<ProxyStreamPart>
    } & Record<string, unknown>,
  ): AsyncIterable<SSEOutput<TSSEData>>
  /** 策略专属的请求侧 enrichment 计算。仅 openai-responses 实现；
   *  返回的不透明对象由编排器原样透传给 renderStreamSSE / renderResult。 */
  prepareEnrichment?(request: TRequest, providerType: string): Record<string, unknown> | undefined
  /** passthrough 直通转发：返回 Response 表示已透传（直接 pipe 后端响应）；
   *  返回 undefined 表示不走 passthrough（回退 AI SDK 序列化/解析路径）。
   *  仅 openai-responses + openai 上游实现。 */
  passthrough?(input: PassthroughInput<TRequest>): Promise<Response | undefined>
  /** 错误格式化器：按协议风格格式化各类错误 */
  formatErrors: ProtocolErrorFormatter
}
