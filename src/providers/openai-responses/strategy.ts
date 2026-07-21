import type {
  ProtocolExecutionOverride,
  ProtocolProviderAwareMapping,
  ProtocolRenderEnrichment,
  ProtocolStrategy,
  ProtocolVisionInputFilter,
} from '../shared/strategy.js'
import { openAIErrorFormat } from '../shared/error-format.js'
import { validateOpenAIResponsesRequest, mapResponsesRequestToAISDKInput } from './protocol.js'
import { buildResponsesEnrichment } from './enrichment.js'
import { renderOpenAIResponse, renderOpenAIResponseSSE } from './renderer.js'
import { prepareOpenAIResponsesPassthroughExecution } from './passthrough.js'
import {
  applyUnsupportedOpenAIResponsesVisionInput,
  planUnsupportedOpenAIResponsesVisionInput,
} from './vision-input.js'
import type { OpenAIResponsesRequest } from './protocol.js'
import type { OpenAIResponse, OpenAIResponseStreamEvent, ResponsesEnrichment } from './types.js'

export const openaiResponsesStrategy: ProtocolStrategy<
  OpenAIResponsesRequest,
  OpenAIResponseStreamEvent,
  OpenAIResponse,
  ResponsesEnrichment
> &
  ProtocolProviderAwareMapping<OpenAIResponsesRequest> &
  ProtocolRenderEnrichment<OpenAIResponsesRequest, ResponsesEnrichment> &
  ProtocolExecutionOverride<OpenAIResponseStreamEvent, OpenAIResponse, ResponsesEnrichment> &
  ProtocolVisionInputFilter = {
  visionInputProtocol: 'openai-responses',
  planUnsupportedVisionInput: planUnsupportedOpenAIResponsesVisionInput,
  applyUnsupportedVisionInput: applyUnsupportedOpenAIResponsesVisionInput,
  validate: validateOpenAIResponsesRequest,
  validationMessage: 'Invalid OpenAI Responses request',
  getModel: (req) => req.model,
  isStream: (req) => req.stream ?? false,
  mapToAISDKInput: mapResponsesRequestToAISDKInput,
  mapToProviderAISDKInput: mapResponsesRequestToAISDKInput,
  prepareEnrichment: buildResponsesEnrichment,
  prepareExecution: prepareOpenAIResponsesPassthroughExecution,
  renderResult: renderOpenAIResponse,
  renderStreamSSE: renderOpenAIResponseSSE,
  formatErrors: openAIErrorFormat,
}
