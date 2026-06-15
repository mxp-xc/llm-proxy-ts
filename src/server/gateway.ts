import { generateText, streamText } from 'ai'
import { logger as defaultLogger } from './logging.js'
import type { ModelGateway } from './types.js'

export const defaultGateway: ModelGateway = {
  async generate({ model, callInput, abortSignal }) {
    return generateText({ model, ...callInput, abortSignal } as Parameters<typeof generateText>[0])
  },
  stream({ model, callInput, abortSignal }) {
    return streamText({
      model,
      ...callInput,
      abortSignal,
      // AI SDK streamText 抑制异常并整合到 fullStream 中作为 { type: 'error' } chunk。
      // onError 仅是日志回调，不改变流行为；error chunk 会经过插件检查流程。
      onError: ({ error }) => {
        defaultLogger.error({ err: error }, 'stream error from AI SDK')
      },
    } as Parameters<typeof streamText>[0])
      .fullStream as AsyncIterable<unknown>
  },
}
