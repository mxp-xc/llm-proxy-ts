import type { ProtocolStrategy } from '../shared/strategy.js'
import { openAIErrorFormat } from '../shared/error-format.js'
import {
  validateOpenAIResponsesRequest,
  mapResponsesRequestToAISDKInput,
  getResponsesCustomToolNames,
  hasClientToolSearch,
  getResponsesNamespaceFlatMap,
} from './protocol.js'
import { renderOpenAIResponse, renderOpenAIResponseSSE } from './renderer.js'
import type { OpenAIResponsesRequest } from './protocol.js'
import type { OpenAIResponse, OpenAIResponseStreamEvent } from './types.js'

export const openaiResponsesStrategy: ProtocolStrategy<
  OpenAIResponsesRequest,
  OpenAIResponseStreamEvent,
  OpenAIResponse
> = {
  validate: validateOpenAIResponsesRequest,
  validationMessage: 'Invalid OpenAI Responses request',
  getModel: (req) => req.model,
  isStream: (req) => req.stream ?? false,
  mapToAISDKInput: mapResponsesRequestToAISDKInput,
  getCustomToolNames: getResponsesCustomToolNames,
  getHasClientToolSearch: hasClientToolSearch,
  getNamespaceFlatMap: getResponsesNamespaceFlatMap,
  renderResult: renderOpenAIResponse,
  renderStreamSSE: renderOpenAIResponseSSE,
  formatErrors: openAIErrorFormat,
}
