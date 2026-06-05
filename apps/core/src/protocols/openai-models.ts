import type { Settings } from '../config.js';
import { isFlatLookupEnabled } from '../config-helpers.js';
import type { OpenAIModel, OpenAIModelList } from './openai-types.js';

export function listModels(settings: Settings): OpenAIModelList {
  const data: OpenAIModel[] = [];

  for (const [providerName, provider] of Object.entries(settings.providers)) {
    const flatEnabled = isFlatLookupEnabled(provider, settings);

    for (const [modelKey, model] of Object.entries(provider.models)) {
      data.push({
        id: `${providerName}/${modelKey}`,
        object: 'model',
        created: 0,
        owned_by: providerName,
      });

      if (flatEnabled) {
        data.push({
          id: modelKey,
          object: 'model',
          created: 0,
          owned_by: providerName,
        });
        for (const alias of model.aliases) {
          data.push({
            id: alias,
            object: 'model',
            created: 0,
            owned_by: providerName,
          });
        }
      }
    }
  }

  return { object: 'list', data };
}

export function getModel(settings: Settings, modelId: string): OpenAIModel | null {
  const slashIndex = modelId.indexOf('/');

  // provider/modelKey 格式
  if (slashIndex > 0) {
    const providerName = modelId.slice(0, slashIndex);
    const modelKey = modelId.slice(slashIndex + 1);
    if (!modelKey) {
      return null;
    }

    const provider = settings.providers[providerName];
    if (!provider?.models[modelKey]) {
      return null;
    }

    return {
      id: modelId,
      object: 'model',
      created: 0,
      owned_by: providerName,
    };
  }

  // 扁平名称查找 — 仅搜索启用了 flat lookup 的 provider
  for (const [providerName, provider] of Object.entries(settings.providers)) {
    if (!isFlatLookupEnabled(provider, settings)) {
      continue;
    }

    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (modelKey === modelId) {
        return {
          id: modelId,
          object: 'model',
          created: 0,
          owned_by: providerName,
        };
      }
      if (model.aliases.includes(modelId)) {
        return {
          id: modelId,
          object: 'model',
          created: 0,
          owned_by: providerName,
        };
      }
    }
  }

  return null;
}
