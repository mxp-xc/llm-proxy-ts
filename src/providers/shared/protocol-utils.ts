import { jsonSchema, type ToolSet } from 'ai'

export function mapProviderOptions<T extends Record<string, unknown>>(
  request: T,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(request).filter(([key]) => !knownKeys.has(key)))
}

export function mapToolToAISDK(
  parameters: Record<string, unknown>,
  description?: string,
): ToolSet[string] {
  const def: ToolSet[string] = { inputSchema: jsonSchema(parameters) }
  if (description !== undefined) def.description = description
  return def
}
