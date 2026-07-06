export type ParsedModelSelector =
  | { kind: 'flat'; name: string }
  | { kind: 'prefixed'; provider: string; name: string }
  | { kind: 'invalid' }

export function parseModelSelector(selector: string): ParsedModelSelector {
  const slashIndex = selector.indexOf('/')
  if (slashIndex < 0) return { kind: 'flat', name: selector }
  if (slashIndex === 0 || slashIndex === selector.length - 1) return { kind: 'invalid' }
  return {
    kind: 'prefixed',
    provider: selector.slice(0, slashIndex),
    name: selector.slice(slashIndex + 1),
  }
}

export function canUseFlatModelSelector(name: string): boolean {
  return name.length > 0 && !name.includes('/')
}
