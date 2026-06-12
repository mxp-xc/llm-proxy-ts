import type { ProtocolStrategy } from '../shared/strategy.js'
import { openAIErrorFormat } from '../shared/error-format.js'
import { validateOpenAIResponsesRequest, mapResponsesRequestToAISDKInput } from './protocol.js'
import { renderOpenAIResponse, renderOpenAIResponseSSE } from './renderer.js'
import type { OpenAIResponsesRequest } from './protocol.js'

export const openaiResponsesStrategy: ProtocolStrategy<OpenAIResponsesRequest> = {
  validate: validateOpenAIResponsesRequest,
  getModel: (req) => req.model,
  isStream: (req) => req.stream ?? false,
  mapToAISDKInput: mapResponsesRequestToAISDKInput,
  renderResult: renderOpenAIResponse,
  renderStreamSSE: renderOpenAIResponseSSE,
  formatErrors: openAIErrorFormat,
}
