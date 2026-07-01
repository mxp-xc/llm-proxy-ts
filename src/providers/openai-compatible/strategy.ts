import type { ProtocolStrategy } from '../shared/strategy.js'
import { openAIErrorFormat } from '../shared/error-format.js'
import { validateOpenAIChatRequest, mapOpenAIChatRequestToAISDKInput } from './protocol.js'
import { renderOpenAIChatCompletion, renderOpenAIChatCompletionSSE } from './renderer.js'
import type { OpenAIChatRequest } from './protocol.js'
import type { OpenAIChatCompletion, OpenAIChatChunk, OpenAIChatStreamError } from './types.js'

export const openaiCompatibleStrategy: ProtocolStrategy<
  OpenAIChatRequest,
  OpenAIChatChunk | OpenAIChatStreamError,
  OpenAIChatCompletion
> = {
  validate: validateOpenAIChatRequest,
  validationMessage: 'Invalid OpenAI chat completion request',
  getModel: (req) => req.model,
  isStream: (req) => req.stream ?? false,
  mapToAISDKInput: mapOpenAIChatRequestToAISDKInput,
  renderResult: renderOpenAIChatCompletion,
  renderStreamSSE: renderOpenAIChatCompletionSSE,
  formatErrors: openAIErrorFormat,
}
