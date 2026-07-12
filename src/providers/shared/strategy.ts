import type { AISDKInput, ProxyStreamPart } from './aisdk-types.js'
import type { SSEOutput } from './sse-utils.js'
import type { RenderResultInput } from '../protocol-types.js'
import type { ProtocolErrorFormatter } from './error-format.js'
import type { LanguageModelOptions } from '../registry.js'
import type { GatewayGenerateOptions, GatewayStreamOptions } from '../../server/types.js'

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
  mapToAISDKInput(request: TRequest): AISDKInput
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

export interface ProtocolProviderAwareMapping<TRequest> {
  /** 仅 provider 类型会改变映射语义时实现，避免把 provider 参数扩散到所有策略。 */
  mapToProviderAISDKInput(request: TRequest, providerType: string): AISDKInput
}

export interface ExecutionOverrideInput {
  providerType: string
  rawBody: unknown
}

export interface ExecutionOverrideConfig<TSSEData, TResult, TEnrichment extends object> {
  languageModelOptions?: LanguageModelOptions
  generateOptions?: GatewayGenerateOptions
  streamOptions?: GatewayStreamOptions
  renderResult?: (input: RenderResultInput & TEnrichment) => TResult
  renderStreamSSE?: (
    input: {
      model: string
      stream: AsyncIterable<ProxyStreamPart>
    } & TEnrichment,
  ) => AsyncIterable<SSEOutput<TSSEData>>
  responseHeaders?: (input: RenderResultInput & TEnrichment) => HeadersInit | undefined
  streamResponseHeaders?: () => HeadersInit | undefined
}

export interface ProtocolExecutionOverride<TSSEData, TResult, TEnrichment extends object> {
  /** 为特定 provider/request 替换执行细节；undefined 表示继续普通矩阵转换路径。 */
  prepareExecution(
    input: ExecutionOverrideInput,
  ): ExecutionOverrideConfig<TSSEData, TResult, TEnrichment> | undefined
}
