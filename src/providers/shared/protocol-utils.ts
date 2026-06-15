export function mapProviderOptions(
  request: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => !knownKeys.has(key)),
  )
}
