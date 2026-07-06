import { isFlatLookupEnabled } from '../config-helpers.js'
import type { AliasEntry, Settings } from '../config.js'
import { canUseFlatModelSelector } from '../model-selector.js'

/** 模型 token 限制 */
export interface ModelLimit {
  /** 总上下文窗口长度（含输入+输出）。来自上游 context_length 等字段 */
  context?: number | undefined
  /** 输入 token 上限。无上游标准字段，需手动配置 */
  input?: number | undefined
  /** 输出 token 上限。来自上游 max_output_tokens 等字段 */
  output?: number | undefined
}

export interface OpenAIModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  limit?: ModelLimit
}

export interface OpenAIModelList {
  object: 'list'
  data: OpenAIModel[]
}

/**
 * 单个 modelKey 的枚举条目,携带该 model 对外暴露的全部 id。
 *
 * `ids` 顺序固定为:
 * `[`${providerName}/${modelKey}`,
 *  ...(modelFlat ? [modelKey] : []),
 *  ...flatMap(alias => [`${providerName}/${alias.name}`, ...(modelFlat || alias.flat ? [alias.name] : [])])]`
 *
 * 带前缀入口(`provider/name`)始终存在;裸名入口仅当 `modelFlat || alias.flat` 时出现。
 * `modelFlat = isFlatLookupEnabled(provider, settings) || !!model.flat`。
 */
export interface ModelEntry {
  providerName: string
  modelKey: string
  upstreamModel: string
  aliases: AliasEntry[]
  limit: ModelLimit | undefined
  modelFlat: boolean
  ids: string[]
}

/**
 * 遍历 settings.providers 的所有 (provider, modelKey),构建共享枚举条目。
 *
 * provider 与 model 均按对象插入顺序遍历(`Object.entries`),与原各消费者一致。
 * `aliases` 返回配置值的浅拷贝,避免调用方意外修改配置。
 */
export function enumerateModelEntries(settings: Settings): ModelEntry[] {
  const entries: ModelEntry[] = []
  for (const [providerName, provider] of Object.entries(settings.providers)) {
    const providerFlat = isFlatLookupEnabled(provider, settings)
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const modelFlat = providerFlat || !!model.flat
      const ids: string[] = [`${providerName}/${modelKey}`]
      if (modelFlat && canUseFlatModelSelector(modelKey)) {
        ids.push(modelKey)
      }
      for (const alias of model.aliases) {
        ids.push(`${providerName}/${alias.name}`)
        if ((modelFlat || alias.flat) && canUseFlatModelSelector(alias.name)) {
          ids.push(alias.name)
        }
      }
      entries.push({
        providerName,
        modelKey,
        upstreamModel: model.upstreamModel,
        aliases: [...model.aliases],
        limit: model.limit,
        modelFlat,
        ids,
      })
    }
  }
  return entries
}
