import type { Settings } from '../config.js'
import {
  enumerateModelEntries,
  type ModelLimit,
  type OpenAIModel,
  type OpenAIModelList,
} from './model-types.js'

/** 构造 OpenAIModel，仅在 limit 有值时附带 */
function makeModel(id: string, ownedBy: string, limit?: ModelLimit): OpenAIModel {
  const hasLimit = limit && (limit.context != null || limit.input != null || limit.output != null)
  return hasLimit
    ? { id, object: 'model', created: 0, owned_by: ownedBy, limit }
    : { id, object: 'model', created: 0, owned_by: ownedBy }
}

export function listModels(settings: Settings): OpenAIModelList {
  const data: OpenAIModel[] = enumerateModelEntries(settings).flatMap((entry) =>
    entry.ids.map((id) => makeModel(id, entry.providerName, entry.limit)),
  )
  return { object: 'list', data }
}

export function getModel(settings: Settings, modelId: string): OpenAIModel | null {
  return new Map(listModels(settings).data.map((model) => [model.id, model])).get(modelId) ?? null
}
