import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'

/**
 * 规范化 AI SDK fullStream → ProxyStreamPart。
 *
 * AI SDK 将 response 元数据放在 finish-step.response，而非 finish 上。
 * 此规范化层从 finish-step 捕获 response，并在 finish part 到达时注入，
 * 使下游消费者（stream-collector、renderers）能从 finish part 读取 response。
 */
export async function* normalizeStream(
  stream: AsyncIterable<ProxyStreamPart>,
): AsyncIterable<ProxyStreamPart> {
  let lastStepResponse: { id?: string; timestamp?: Date } | undefined

  for await (const part of stream) {
    if (part.type === 'finish-step' && part.response) {
      const resp = part.response as Record<string, unknown>
      lastStepResponse = {}
      if (typeof resp.id === 'string') lastStepResponse.id = resp.id
      if (resp.timestamp instanceof Date) lastStepResponse.timestamp = resp.timestamp
    }

    if (part.type === 'finish') {
      yield lastStepResponse
        ? { ...part, response: lastStepResponse }
        : part
    } else {
      yield part
    }
  }
}
