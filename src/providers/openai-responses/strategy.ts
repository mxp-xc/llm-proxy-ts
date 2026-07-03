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
import type { OpenAIResponse, OpenAIResponseStreamEvent, ResponsesEnrichment } from './types.js'

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
  prepareEnrichment: (request, providerType): ResponsesEnrichment | undefined => {
    const customToolNames = getResponsesCustomToolNames(request)
    const customToolShimmed = customToolNames !== undefined && providerType !== 'openai'
    const toolSearchShimmed = providerType !== 'openai' && hasClientToolSearch(request)
    const namespaceFlatMap = getResponsesNamespaceFlatMap(request)
    const enrichment: ResponsesEnrichment = {}
    if (customToolNames) enrichment.customToolNames = customToolNames
    if (customToolShimmed) enrichment.customToolShimmed = true
    if (toolSearchShimmed) enrichment.toolSearchShimmed = true
    if (namespaceFlatMap) enrichment.namespaceFlatMap = namespaceFlatMap
    return Object.keys(enrichment).length > 0 ? enrichment : undefined
  },
  renderResult: renderOpenAIResponse,
  renderStreamSSE: renderOpenAIResponseSSE,
  formatErrors: openAIErrorFormat,
}
