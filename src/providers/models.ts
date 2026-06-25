import type { Settings } from '../config.js'
import { isFlatLookupEnabled } from '../config-helpers.js'
import { enumerateModelEntries, type ModelLimit, type OpenAIModel, type OpenAIModelList } from './model-types.js'

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
  const slashIndex = modelId.indexOf('/')

  // provider/<modelKey 或 alias-name> 格式
  if (slashIndex > 0) {
    const providerName = modelId.slice(0, slashIndex)
    const requestedModel = modelId.slice(slashIndex + 1)
    if (!requestedModel) {
      return null
    }

    const provider = settings.providers[providerName]
    if (provider?.models[requestedModel]) {
      return makeModel(modelId, providerName, provider.models[requestedModel].limit)
    }
    for (const model of Object.values(provider?.models ?? {})) {
      if (model.aliases.some((a) => a.name === requestedModel)) {
        return makeModel(modelId, providerName, model.limit)
      }
    }
    return null
  }

  // 扁平名称查找 — modelKey/alias 裸名在 provider/model/alias 级 flat 任一启用时生效
  for (const [providerName, provider] of Object.entries(settings.providers)) {
    const providerFlat = isFlatLookupEnabled(provider, settings)

    for (const [modelKey, model] of Object.entries(provider.models)) {
      const modelFlat = providerFlat || !!model.flat
      if (modelFlat && modelKey === modelId) {
        return makeModel(modelId, providerName, model.limit)
      }
      if (model.aliases.some((a) => (modelFlat || a.flat) && a.name === modelId)) {
        return makeModel(modelId, providerName, model.limit)
      }
    }
  }

  return null
}
