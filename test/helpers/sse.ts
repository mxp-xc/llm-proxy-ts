/**
 * Shared SSE output collector for renderer tests.
 *
 * Works with structured SSEOutput<T> objects (not raw bytes).
 * Returns frames with event name and data payload.
 */
import type { SSEFrame, SSEOutput } from '../../src/providers/shared/sse-utils.js'

/** A collected SSE frame with event name and data payload */
export interface CollectedSSEFrame<T = unknown> {
  event?: string
  data: T
}

/**
 * Collect structured SSEOutput frames from a renderer stream.
 * Filters out SSEDone sentinels — returns only data frames.
 */
export async function collectSSEFrames<T>(
  stream: AsyncIterable<SSEOutput<T>>,
): Promise<Array<CollectedSSEFrame<T>>> {
  const frames: Array<CollectedSSEFrame<T>> = []
  for await (const output of stream) {
    if ('type' in output && output.type === 'done') continue
    const frame = output as SSEFrame<T>
    frames.push(frame.event != null ? { event: frame.event, data: frame.data } : { data: frame.data })
  }
  return frames
}
