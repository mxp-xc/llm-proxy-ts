export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function toolCallIdValue(part: Record<string, unknown>): string | undefined {
  return stringValue(part.toolCallId ?? part.id)
}
