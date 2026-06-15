/**
 * SSE 流式输出的结构化类型与格式化工具。
 *
 * Renderer 产出结构化帧（SSEOutput），SSE 文本格式化和字节编码
 * 统一在 HTTP 边界层完成——renderer 只管"生成什么事件"。
 */

// ─── 通用 SSE 帧类型 ─────────────────────────────────────────────

/** SSE 帧——renderer 的输出单位，data 由各协议泛型参数具体化 */
export interface SSEFrame<T = never> {
  /** 事件类型。Anthropic / OpenAI Responses 使用；OpenAI Chat 不设此字段 */
  event?: string
  /** 帧数据，具体形状由各协议的泛型参数决定 */
  data: T
}

/** OpenAI Chat Completions [DONE] 哨兵 */
export interface SSEDone {
  type: 'done'
}

/** Renderer 流式输出类型 */
export type SSEOutput<T = never> = SSEFrame<T> | SSEDone

// ─── 格式化 ──────────────────────────────────────────────────────

/** 将结构化 SSEOutput 格式化为 SSE 文本行 */
export function formatSSE<T>(output: SSEOutput<T>): string {
  if ('type' in output && output.type === 'done') {
    return 'data: [DONE]\n\n'
  }
  const { event, data } = output as SSEFrame
  const json = JSON.stringify(data)
  return event != null
    ? `event: ${event}\ndata: ${json}\n\n`
    : `data: ${json}\n\n`
}
