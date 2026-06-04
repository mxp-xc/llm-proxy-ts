import type { LanguageModel } from 'ai';
import type { Settings } from '@llm-proxy/core';
import { logger } from '../logging.js';
import { createOpenAICompatibleProvider, sanitizeHeaders } from '@llm-proxy/core';

export interface ProviderRegistry {
  languageModel(providerName: string, upstreamModel: string, modelHeaders: Record<string, string>): LanguageModel;
  debugProviderConfig(providerName: string): { baseURL: string; headers: Record<string, string>; proxyEnabled: boolean };
}

export function createProviderRegistry(settings: Settings): ProviderRegistry {
  const apiKeyIndexes = new Map<string, number>();

  return {
    languageModel(providerName, upstreamModel, modelHeaders) {
      const provider = settings.providers[providerName];
      if (!provider) {
        throw new Error(`Unknown provider '${providerName}'`);
      }

      const selection = selectApiKey(providerName, provider.apiKey, apiKeyIndexes);
      if (selection) {
        logger.info(
          { provider: providerName, keyIndex: selection.index, keyCount: selection.count },
          'selected api key for provider',
        );
      }

      return createOpenAICompatibleProvider(providerName, provider, settings, modelHeaders, selection?.apiKey)(upstreamModel);
    },
    debugProviderConfig(providerName) {
      const provider = settings.providers[providerName];
      if (!provider) {
        throw new Error(`Unknown provider '${providerName}'`);
      }

      return {
        baseURL: provider.baseURL,
        headers: sanitizeHeaders(provider.headers),
        proxyEnabled: settings.proxy !== null,
      };
    },
  };
}

function selectApiKey(
  providerName: string,
  apiKey: string | [string, ...string[]] | null | undefined,
  apiKeyIndexes: Map<string, number>,
): { apiKey: string; index: number; count: number } | undefined {
  if (apiKey === undefined || apiKey === null) {
    return undefined;
  }

  if (typeof apiKey === 'string') {
    return { apiKey, index: 0, count: 1 };
  }

  const index = apiKeyIndexes.get(providerName) ?? 0;
  const selectedIndex = index % apiKey.length;
  const selectedApiKey = apiKey[selectedIndex];
  if (selectedApiKey === undefined) {
    throw new Error(`Missing API key at index ${selectedIndex} for provider '${providerName}'`);
  }
  apiKeyIndexes.set(providerName, index + 1);
  return { apiKey: selectedApiKey, index: selectedIndex, count: apiKey.length };
}
