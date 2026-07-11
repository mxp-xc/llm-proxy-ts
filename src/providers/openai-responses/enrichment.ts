import {
  getResponsesCustomToolNames,
  getResponsesNamespaceFlatMap,
  hasClientToolSearch,
  type OpenAIResponsesRequest,
} from './protocol.js'
import type { ResponsesEnrichment } from './types.js'

export function buildResponsesEnrichment(
  request: OpenAIResponsesRequest,
  providerType: string,
): ResponsesEnrichment | undefined {
  const customToolNames = getResponsesCustomToolNames(request)
  const namespaceFlatMap = getResponsesNamespaceFlatMap(request)

  if (providerType === 'openai') {
    const enrichment: ResponsesEnrichment = { namespacePassthrough: true }
    if (customToolNames) enrichment.customToolNames = customToolNames
    if (namespaceFlatMap) enrichment.namespaceFlatMap = namespaceFlatMap
    return enrichment
  }

  const enrichment: ResponsesEnrichment = {}
  if (customToolNames) {
    enrichment.customToolNames = customToolNames
    enrichment.customToolShimmed = true
  }
  if (hasClientToolSearch(request)) enrichment.toolSearchShimmed = true
  if (namespaceFlatMap) enrichment.namespaceFlatMap = namespaceFlatMap
  return Object.keys(enrichment).length > 0 ? enrichment : undefined
}
