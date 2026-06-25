import { generateText, streamText } from 'ai'
import { logger as defaultLogger } from './logging.js'
import type { ModelGateway } from './types.js'
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

export const defaultGateway: ModelGateway = {
  async generate({ model, callInput, abortSignal }) {
    return generateText({ model, ...callInput, abortSignal } as Parameters<typeof generateText>[0])
  },
  stream({ model, callInput, abortSignal }) {
    const result = streamText({
      model,
      ...callInput,
      abortSignal,
      // AI SDK streamText 抑制异常并整合到 fullStream 中作为 { type: 'error' } chunk。
      // onError 仅是日志回调，不改变流行为；error chunk 会经过插件检查流程。
      onError: ({ error }) => {
        defaultLogger.error({ err: error }, 'stream error from AI SDK')
      },
    } as Parameters<typeof streamText>[0])
    return normalizeStream(result.fullStream as AsyncIterable<ProxyStreamPart>)
  },
}
