/** TOML bare key: letters, digits, A-Z a-z 0-9 _ - */
function isBareKey(segment: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(segment)
}

/** Map of TOML basic-string escape sequences for control characters. */
const TOML_CONTROL_ESCAPES: Record<string, string> = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
}

/** Format a string as a TOML basic string literal (double-quoted, escaped). */
export function formatTomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\b\t\n\f\r]/g, (ch) => TOML_CONTROL_ESCAPES[ch] ?? ch)
  return `"${escaped}"`
}

/** Format a boolean as a TOML bool. */
export function formatTomlBool(value: boolean): string {
  return value ? 'true' : 'false'
}

/** Format an array of key segments as a TOML dotted table header path. */
export function formatTableHeaderPath(segments: string[]): string {
  return segments.map((s) => (isBareKey(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join('.')
}

type FieldValue = string | boolean

function formatFieldValue(value: FieldValue): string {
  return typeof value === 'boolean' ? formatTomlBool(value) : formatTomlString(value)
}

/** Detect the dominant line ending of the content (CRLF if count >= lone LF, else LF). */
function detectEol(content: string): string {
  const crlfCount = countOccurrences(content, '\r\n')
  const lfCount = countOccurrences(content, '\n')
  // lone LF count = total LF minus CRLF (each CRLF contributes one LF)
  const loneLf = lfCount - crlfCount
  return crlfCount >= loneLf && crlfCount > 0 ? '\r\n' : '\n'
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

/** Split content into lines without their trailing newline (handles any line ending). */
function splitLines(content: string, _eol: string): string[] {
  if (content === '') return []
  // Split on any line ending, then drop a trailing empty line produced by a final newline.
  const parts = content.split(/\r\n|\n|\r/)
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

function joinLines(lines: string[], eol: string): string {
  if (lines.length === 0) return ''
  return lines.join(eol) + eol
}

/** Index of the first table header line ([table] or [[table]]), or lines.length if none. */
function findFirstTableLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) return i
  }
  return lines.length
}

/** True if a line is a table header (starts with [ ), including array-of-tables [[. */
function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line)
}

/** True if a line declares `key =` at root (matched against the given key). */
function matchesRootKey(line: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${escaped}\\s*=`).test(line)
}

/** Set (insert or replace) a top-level key. Insertion lands before the first table. */
export function setTopLevelKey(content: string, key: string, value: string): string {
  const eol = detectEol(content)
  const lines = splitLines(content, eol)
  const firstTable = findFirstTableLine(lines)
  const newLine = `${key} = ${value}`

  // Replace existing root key (search only in root region).
  for (let i = 0; i < firstTable; i++) {
    if (matchesRootKey(lines[i]!, key)) {
      const indent = (lines[i]!.match(/^\s*/) ?? [''])[0]
      lines[i] = `${indent}${key} = ${value}`
      return joinLines(lines, eol)
    }
  }

  // Insert before first table (or at EOF). Keep a blank separator before a table.
  if (firstTable < lines.length) {
    const insertAt = firstTable
    const prev = lines[insertAt - 1]
    if (prev === undefined) {
      // Table is the first line: key, blank, then table.
      lines.splice(insertAt, 0, newLine, '')
    } else if (prev.trim() !== '') {
      // Previous line has content: separate with a blank line.
      lines.splice(insertAt, 0, '', newLine)
    } else {
      // Previous line is already blank.
      lines.splice(insertAt, 0, newLine)
    }
  } else {
    // Append at EOF.
    lines.push(newLine)
  }
  return joinLines(lines, eol)
}

/** Header line for a model_providers.<id> table (flat, not array). */
function providerHeaderLine(providerId: string): string {
  return `[${formatTableHeaderPath(['model_providers', providerId])}]`
}

/**
 * True if line is the target provider table header (flat, not [[ ]]),
 * allowing optional trailing whitespace and a `# comment`.
 */
function isProviderHeader(line: string, header: string): boolean {
  if (line.trim().startsWith('[[')) return false // array-of-tables excluded
  // header is `[<path>]`; escape its inner path for regex, allow inner spaces + trailing comment.
  const pathEscaped = header.slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*\\[\\s*${pathEscaped}\\s*\\]\\s*(?:#.*)?$`).test(line)
}

/** Set (create or replace) the [model_providers.<id>] table with exactly the given fields. */
export function setProviderTable(
  content: string,
  providerId: string,
  fields: Record<string, FieldValue>,
): string {
  const eol = detectEol(content)
  const lines = splitLines(content, eol)
  const header = providerHeaderLine(providerId)
  const bodyLines = Object.entries(fields).map(([k, v]) => `${k} = ${formatFieldValue(v)}`)

  // Find existing target table range.
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (isProviderHeader(lines[i]!, header)) {
      start = i
      break
    }
  }

  if (start >= 0) {
    // Find end: next table header or EOF.
    let end = lines.length
    for (let j = start + 1; j < lines.length; j++) {
      if (isTableHeader(lines[j]!)) {
        end = j
        break
      }
    }
    const replacement = [...bodyLines]
    lines.splice(start + 1, end - (start + 1), ...replacement)
    return joinLines(lines, eol)
  }

  // Append new table at EOF with a leading blank separator.
  const block = ['', header, ...bodyLines]
  if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') {
    lines.push(...block)
  } else {
    lines.push(header, ...bodyLines)
  }
  return joinLines(lines, eol)
}

/** Strip surrounding TOML quotes/whitespace from a raw value token. */
function normalizeValue(raw: string): string {
  const trimmed = raw.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Read a root-level key value (normalized), or undefined if missing/not in root. */
export function readTopLevelKey(content: string, key: string): string | undefined {
  const eol = detectEol(content)
  const lines = splitLines(content, eol)
  const firstTable = findFirstTableLine(lines)
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  for (let i = 0; i < firstTable; i++) {
    const m = lines[i]!.match(re)
    if (m) return normalizeValue(m[1]!)
  }
  return undefined
}

/** Read a field value from [model_providers.<id>] (normalized), or undefined. */
export function readProviderTableField(
  content: string,
  providerId: string,
  field: string,
): string | undefined {
  const eol = detectEol(content)
  const lines = splitLines(content, eol)
  const header = providerHeaderLine(providerId)
  let inTable = false
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  for (const line of lines) {
    if (isTableHeader(line)) {
      inTable = isProviderHeader(line, header)
      continue
    }
    if (inTable) {
      const m = line.match(re)
      if (m) return normalizeValue(m[1]!)
    }
  }
  return undefined
}
