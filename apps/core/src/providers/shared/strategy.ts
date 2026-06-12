import type { AISDKInput } from './aisdk-types.js'
import type { RenderResultInput } from '../protocol-types.js'
import type { ProtocolErrorFormatter } from './error-format.js'

/**
 * 策略模式接口：封装特定协议的验证、映射、渲染和错误格式化逻辑。
 * 每种协议格式（openai-compatible、openai-responses、anthropic）提供一个实现。
 */
export interface ProtocolStrategy<TRequest = unknown> {
  /** 验证请求体，无效时抛出 Zod 错误 */
  validate(body: unknown): TRequest
  /** 从已验证的请求中提取模型名（用于路由） */
  getModel(request: TRequest): string
  /** 判断请求是否要求流式响应 */
  isStream(request: TRequest): boolean
  /** 将协议特定请求映射到 AI SDK 输入格式 */
  mapToAISDKInput(request: TRequest, providerName?: string): AISDKInput
  /** 非流式渲染：将 AI SDK 结果渲染为协议特定响应 */
  renderResult(input: RenderResultInput): unknown
  /** 流式渲染：将 AI SDK 流渲染为 SSE Uint8Array 异步迭代 */
  renderStreamSSE(input: { model: string; stream: AsyncIterable<unknown> }): AsyncIterable<Uint8Array>
  /** 错误格式化器：按协议风格格式化各类错误 */
  formatErrors: ProtocolErrorFormatter
}
