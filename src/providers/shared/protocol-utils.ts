export function mapProviderOptions<T extends Record<string, unknown>>(
  request: T,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => !knownKeys.has(key)),
  )
}
