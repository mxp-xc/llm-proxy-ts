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

    // openai 上游原生支持 customTool/toolSearch/namespace：不做兼容 shim/flatten。
    // 仅保留 customToolNames 供 renderer 判别 custom_tool_call（SDK 不暴露 toolCallType 信号），
    // 标记 namespacePassthrough 让响应侧从 providerMetadata.openai.namespace 取 namespace。
    if (providerType === 'openai') {
      const enrichment: ResponsesEnrichment = { namespacePassthrough: true }
      if (customToolNames) enrichment.customToolNames = customToolNames
      return enrichment
    }

    // 非 openai（openai-compatible/anthropic）：协议无 namespace/customTool/toolSearch，降级 shim + flatten
    const namespaceFlatMap = getResponsesNamespaceFlatMap(request)
    const enrichment: ResponsesEnrichment = {}
    if (customToolNames) {
      enrichment.customToolNames = customToolNames
      enrichment.customToolShimmed = true
    }
    if (hasClientToolSearch(request)) enrichment.toolSearchShimmed = true
    if (namespaceFlatMap) enrichment.namespaceFlatMap = namespaceFlatMap
    return Object.keys(enrichment).length > 0 ? enrichment : undefined
  },
  renderResult: renderOpenAIResponse,
  renderStreamSSE: renderOpenAIResponseSSE,
  formatErrors: openAIErrorFormat,
}
