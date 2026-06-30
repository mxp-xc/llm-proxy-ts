import {
  setTopLevelKey,
  setProviderTable,
  readTopLevelKey,
  readProviderTableField,
  formatTomlString,
  formatTomlBool,
  removeTopLevelKey,
} from './toml-editor.js'

export interface CodexConfigEdits {
  catalogFilename: string
  providerId: string
  providerName: string
  baseUrl: string
  wireApi: 'responses'
  modelSlug: string
  requiresOpenaiAuth: boolean
  modelReasoningEffort?: string
  checkForUpdateOnStartup: boolean
}

export interface TomlOverwriteReport {
  kind: 'top-level-key' | 'provider-table'
  key: string
  oldValue: string
  newValue: string
}

/** Apply the 4 codex config edits, reporting any values overwritten. */
export function applyCodexConfigEdits(
  content: string,
  params: CodexConfigEdits,
): { content: string; overwritten: TomlOverwriteReport[] } {
  const overwritten: TomlOverwriteReport[] = []
  let cur = content

  const topKeys: Array<{ key: string; newValue: string }> = [
    { key: 'model_catalog_json', newValue: formatTomlString(params.catalogFilename) },
    { key: 'model_provider', newValue: formatTomlString(params.providerId) },
    { key: 'model', newValue: formatTomlString(params.modelSlug) },
  ]
  for (const { key, newValue } of topKeys) {
    const oldRaw = readTopLevelKey(cur, key)
    if (oldRaw !== undefined && oldRaw !== normalizeTomlString(newValue)) {
      overwritten.push({ kind: 'top-level-key', key, oldValue: oldRaw, newValue: normalizeTomlString(newValue) })
    }
    cur = setTopLevelKey(cur, key, newValue)
  }

  // check_for_update_on_startup: top-level bool.
  {
    const formatted = formatTomlBool(params.checkForUpdateOnStartup)
    const oldRaw = readTopLevelKey(cur, 'check_for_update_on_startup')
    if (oldRaw !== undefined && oldRaw !== formatted) {
      overwritten.push({ kind: 'top-level-key', key: 'check_for_update_on_startup', oldValue: oldRaw, newValue: formatted })
    }
    cur = setTopLevelKey(cur, 'check_for_update_on_startup', formatted)
  }

  // model_reasoning_effort: set when provided, remove when not (avoid stale value from prior install).
  if (params.modelReasoningEffort !== undefined) {
    const formatted = formatTomlString(params.modelReasoningEffort)
    const oldRaw = readTopLevelKey(cur, 'model_reasoning_effort')
    if (oldRaw !== undefined && oldRaw !== normalizeTomlString(formatted)) {
      overwritten.push({ kind: 'top-level-key', key: 'model_reasoning_effort', oldValue: oldRaw, newValue: normalizeTomlString(formatted) })
    }
    cur = setTopLevelKey(cur, 'model_reasoning_effort', formatted)
  } else {
    const oldRaw = readTopLevelKey(cur, 'model_reasoning_effort')
    if (oldRaw !== undefined) {
      overwritten.push({ kind: 'top-level-key', key: 'model_reasoning_effort', oldValue: oldRaw, newValue: '<removed>' })
      cur = removeTopLevelKey(cur, 'model_reasoning_effort')
    }
  }

  // Provider table.
  const fields: Record<string, string | boolean> = {
    name: params.providerName,
    base_url: params.baseUrl,
    wire_api: params.wireApi,
    requires_openai_auth: params.requiresOpenaiAuth,
  }
  const oldName = readProviderTableField(cur, params.providerId, 'name')
  const oldBaseUrl = readProviderTableField(cur, params.providerId, 'base_url')
  const oldWireApi = readProviderTableField(cur, params.providerId, 'wire_api')
  const oldRequiresAuth = readProviderTableField(cur, params.providerId, 'requires_openai_auth')
  const requiresAuthStr = formatTomlBool(params.requiresOpenaiAuth)
  if (
    oldName !== undefined ||
    oldBaseUrl !== undefined ||
    oldWireApi !== undefined ||
    oldRequiresAuth !== undefined
  ) {
    const changed =
      (oldName !== undefined && oldName !== params.providerName) ||
      (oldBaseUrl !== undefined && oldBaseUrl !== params.baseUrl) ||
      (oldWireApi !== undefined && oldWireApi !== params.wireApi) ||
      (oldRequiresAuth !== undefined && oldRequiresAuth !== requiresAuthStr)
    if (changed || oldName === undefined || oldBaseUrl === undefined || oldWireApi === undefined || oldRequiresAuth === undefined) {
      overwritten.push({
        kind: 'provider-table',
        key: params.providerId,
        oldValue: '<existing table>',
        newValue: '<replaced>',
      })
    }
  }
  cur = setProviderTable(cur, params.providerId, fields)

  return { content: cur, overwritten }
}

/**
 * Normalize a formatted TOML string literal for comparison with a stored value.
 * Mirrors `normalizeValue` in toml-editor.ts: strip outer quotes (both `'` and `"`)
 * WITHOUT unescaping, so both sides of the comparison are "de-quoted, not unescaped".
 */
function normalizeTomlString(formatted: string): string {
  const trimmed = formatted.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
