import type { DisabledToolEntry } from './config.js'
import type { AISDKInput } from './providers/shared/aisdk-types.js'

function compileGlob(pattern: string): RegExp {
  let source = '^'
  for (const character of pattern) {
    if (character === '*') {
      source += '.*'
    } else if (character === '?') {
      source += '.'
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

export class ToolNameMatcher {
  private readonly exactNames: Set<string>
  private readonly globPatterns: RegExp[]

  constructor(entries: readonly DisabledToolEntry[]) {
    this.exactNames = new Set()
    const globs = new Set<string>()
    for (const entry of entries) {
      if (typeof entry === 'string') {
        this.exactNames.add(entry)
      } else {
        globs.add(entry.glob)
      }
    }
    this.globPatterns = [...globs].map(compileGlob)
  }

  get isEmpty(): boolean {
    return this.exactNames.size === 0 && this.globPatterns.length === 0
  }

  matches(name: string): boolean {
    return this.exactNames.has(name) || this.globPatterns.some((pattern) => pattern.test(name))
  }
}

export function filterDisabledTools(input: AISDKInput, matcher: ToolNameMatcher): AISDKInput {
  if (matcher.isEmpty || input.tools === undefined) return input

  const retainedTools: NonNullable<AISDKInput['tools']> = {}
  const removedNames = new Set<string>()
  for (const [name, tool] of Object.entries(input.tools)) {
    if (matcher.matches(name)) {
      removedNames.add(name)
    } else {
      retainedTools[name] = tool
    }
  }
  if (removedNames.size === 0) return input

  const filtered: AISDKInput = { ...input }
  const hasRetainedTools = Object.keys(retainedTools).length > 0
  if (hasRetainedTools) {
    filtered.tools = retainedTools
  } else {
    delete filtered.tools
  }

  if (typeof input.toolChoice === 'object' && removedNames.has(input.toolChoice.toolName)) {
    filtered.toolChoice = 'auto'
  } else if (!hasRetainedTools && input.toolChoice === 'required') {
    filtered.toolChoice = 'auto'
  }

  return filtered
}
