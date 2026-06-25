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

  // provider/modelKey 格式
  if (slashIndex > 0) {
    const providerName = modelId.slice(0, slashIndex)
    const modelKey = modelId.slice(slashIndex + 1)
    if (!modelKey) {
      return null
    }

    const provider = settings.providers[providerName]
    const model = provider?.models[modelKey]
    if (!model) {
      return null
    }

    return makeModel(modelId, providerName, model.limit)
  }

  // 扁平名称查找 — 仅搜索启用了 flat lookup 的 provider
  for (const [providerName, provider] of Object.entries(settings.providers)) {
    if (!isFlatLookupEnabled(provider, settings)) {
      continue
    }

    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (modelKey === modelId) {
        return makeModel(modelId, providerName, model.limit)
      }
      if (model.aliases.includes(modelId)) {
        return makeModel(modelId, providerName, model.limit)
      }
    }
  }

  return null
}
