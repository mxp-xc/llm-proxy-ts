/**
 * Shared SSE event collector for renderer tests.
 *
 * Supports two SSE formats:
 * 1. `data: {json}` (OpenAI Chat Completions style)
 * 2. `event: type\ndata: json` (Anthropic / OpenAI Responses style)
 */
export async function collectSSEEvents(
  stream: AsyncIterable<Uint8Array>,
): Promise<Array<{ event?: string; data: any }>> {
  const decoder = new TextDecoder()
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk))
  }
  const raw = chunks.join('')

  const results: Array<{ event?: string; data: any }> = []
  const parts = raw.split('\n\n').filter((p) => p.trim())

  for (const part of parts) {
    const lines = part.split('\n')
    const eventLine = lines.find((l) => l.startsWith('event: '))
    const dataLines = lines.filter((l) => l.startsWith('data: '))

    if (dataLines.length === 0) continue

    // SSE spec: multiple data: lines are joined with \n
    const dataStr = dataLines.map((l) => l.slice('data: '.length)).join('\n')
    try {
      results.push({
        ...(eventLine ? { event: eventLine.slice('event: '.length) } : {}),
        data: JSON.parse(dataStr),
      })
    } catch {
      // skip unparseable (e.g. [DONE])
    }
  }

  return results
}
