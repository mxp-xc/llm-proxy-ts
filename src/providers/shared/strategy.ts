import type { AISDKInput, ProxyStreamPart } from './aisdk-types.js'
import type { SSEOutput } from './sse-utils.js'
import type { RenderResultInput } from '../protocol-types.js'
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
  /** 错误格式化器：按协议风格格式化各类错误 */
  formatErrors: ProtocolErrorFormatter
}
