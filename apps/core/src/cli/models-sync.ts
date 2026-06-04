import * as clack from '@clack/prompts';
import { readFile } from 'node:fs/promises';
import { parse, type ParseError } from 'jsonc-parser';
import { loadSettingsFromFile, resolveEnvPlaceholders } from '../config.js';
import type { ModelRouteConfig, Settings } from '../config.js';
import { fetchUpstreamModels, type OpenAIModel } from './discover-models.js';
import { applyMultipleProviderModels, writeSettingsFile } from './settings-writer.js';

export interface ModelsSyncOptions {
  settingsPath: string;
  provider?: string;
  dryRun?: boolean;
}

interface ProviderModelsResult {
  providerName: string;
  models: OpenAIModel[];
  existingModels: Record<string, ModelRouteConfig>;
}

export async function runModelsSync(options: ModelsSyncOptions): Promise<void> {
  const { settingsPath, provider: providerFlag, dryRun = false } = options;

  clack.intro('llm-proxy models sync');

  // 1. 加载配置
  clack.log.step(`Loading settings from ${settingsPath}`);

  let settings: Settings;
  try {
    settings = await loadSettingsFromFile(settingsPath);
  } catch (err) {
    clack.log.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`);
    clack.outro('Aborted');
    return;
  }

  const providerNames = Object.keys(settings.providers);
  if (providerNames.length === 0) {
    clack.log.warn('No providers configured in settings');
    clack.outro('Done');
    return;
  }

  // 读取原始 JSONC 文本（用于后续保留注释的写入）
  let rawText: string;
  try {
    rawText = await readFile(settingsPath, 'utf8');
  } catch (err) {
    clack.log.error(`Failed to read settings file: ${err instanceof Error ? err.message : String(err)}`);
    clack.outro('Aborted');
    return;
  }

  // 解析原始 JSONC 以获取未解析 env 占位符的 apiKey
  const rawErrors: ParseError[] = [];
  const rawParsed = parse(rawText, rawErrors, { allowTrailingComma: true }) as Record<string, unknown>;

  // 2. 选择 provider
  let selectedProviders: string[];
  if (providerFlag) {
    if (!settings.providers[providerFlag]) {
      clack.log.error(`Provider "${providerFlag}" not found in settings`);
      clack.outro('Aborted');
      return;
    }
    selectedProviders = [providerFlag];
    clack.log.step(`Syncing provider: ${providerFlag}`);
  } else if (providerNames.length === 1) {
    selectedProviders = [providerNames[0]!];
    clack.log.step(`Auto-selected provider: ${selectedProviders[0]}`);
  } else {
    const selected = await clack.multiselect({
      message: 'Select providers to sync',
      options: providerNames.map((name) => {
        const opt: { value: string; label: string; hint?: string } = { value: name, label: name };
        const baseURL = settings.providers[name]?.baseURL;
        if (baseURL) opt.hint = baseURL;
        return opt;
      }),
      required: true,
    });

    if (clack.isCancel(selected)) {
      clack.cancel('Operation cancelled');
      return;
    }

    selectedProviders = selected as string[];
  }

  // 3. 发现模型
  const results: ProviderModelsResult[] = [];

  for (const providerName of selectedProviders) {
    const provider = settings.providers[providerName]!;
    const s = clack.spinner();
    s.start(`Fetching models from ${providerName}...`);

    try {
      const rawProviders = rawParsed['providers'] as Record<string, Record<string, unknown>> | undefined;
      const rawProvider = rawProviders?.[providerName];
      const resolvedApiKey = rawProvider?.['apiKey'] != null
        ? (resolveEnvPlaceholders(rawProvider['apiKey']) as string | string[] | null)
        : provider.apiKey;

      const models = await fetchUpstreamModels({
        baseURL: provider.baseURL,
        apiKey: resolvedApiKey,
        proxySettings: settings.proxy,
      });

      s.stop(`Found ${models.length} models from ${providerName}`);
      results.push({
        providerName,
        models,
        existingModels: provider.models,
      });
    } catch (err) {
      s.stop(`Failed to fetch models from ${providerName}`);
      clack.log.warn(`${providerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (results.length === 0) {
    clack.log.error('Could not fetch models from any provider');
    clack.outro('Aborted');
    return;
  }

  // 4. 选择模型
  const changes: Array<{ providerName: string; newModels: Record<string, ModelRouteConfig>; added: number; kept: number; removed: number }> = [];

  for (const { providerName, models, existingModels } of results) {
    const existingKeys = Object.keys(existingModels);

    const options = models.map((model) => {
      const opt: { value: string; label: string; hint?: string } = { value: model.id, label: model.id };
      if (model.owned_by) opt.hint = model.owned_by;
      return opt;
    });

    const initialValues: string[] = [];
    for (const key of existingKeys) {
      const upstreamModel = existingModels[key]?.upstreamModel;
      if (upstreamModel && models.some((m) => m.id === upstreamModel)) {
        initialValues.push(upstreamModel);
      }
    }

    const selected = await clack.autocompleteMultiselect({
      message: `Select models for ${providerName} (${models.length} available)`,
      options,
      initialValues,
      placeholder: 'Type to search models...',
      required: false,
    });

    if (clack.isCancel(selected)) {
      clack.cancel('Operation cancelled');
      return;
    }

    const selectedIds = new Set(selected as string[]);

    const newModels: Record<string, ModelRouteConfig> = {};
    let kept = 0;
    let added = 0;

    for (const modelId of selectedIds) {
      const existingEntry = Object.entries(existingModels).find(
        ([, config]) => config.upstreamModel === modelId,
      );

      if (existingEntry) {
        newModels[existingEntry[0]] = existingEntry[1];
        kept++;
      } else {
        newModels[modelId] = { upstreamModel: modelId };
        added++;
      }
    }

    const removed = existingKeys.length - kept;

    changes.push({ providerName, newModels, added, kept, removed });

    const parts: string[] = [];
    if (added > 0) parts.push(`+${added} new`);
    if (kept > 0) parts.push(`${kept} kept`);
    if (removed > 0) parts.push(`-${removed} removed`);
    clack.log.step(`${providerName}: ${parts.join(', ') || 'no changes'}`);
  }

  const hasChanges = changes.some((c) => c.added > 0 || c.removed > 0);
  if (!hasChanges) {
    clack.log.info('No changes to apply');
    clack.outro('Done');
    return;
  }

  if (dryRun) {
    clack.log.info('Dry run — no changes written');
    clack.outro('Done');
    return;
  }

  const shouldApply = await clack.confirm({
    message: 'Apply changes to settings.jsonc?',
  });

  if (clack.isCancel(shouldApply) || !shouldApply) {
    clack.cancel('Operation cancelled');
    return;
  }

  try {
    const modifiedText = applyMultipleProviderModels(
      rawText,
      changes.map((c) => ({ providerName: c.providerName, newModels: c.newModels })),
    );

    await writeSettingsFile(settingsPath, modifiedText);
    clack.log.success('Settings updated');
  } catch (err) {
    clack.log.error(`Failed to write settings: ${err instanceof Error ? err.message : String(err)}`);
    clack.outro('Aborted');
    return;
  }

  clack.outro('Done');
}
