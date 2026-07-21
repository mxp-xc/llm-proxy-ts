import { describe, expect, it } from 'vitest'
import { RequestTimeoutError, withRequestTimeout } from '../src/request-timeout.js'

describe('withRequestTimeout', () => {
  it('preserves the timeout error when an abort listener rejects upstream immediately', async () => {
    const abortController = new AbortController()
    const upstream = new Promise<never>((_resolve, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
      })
    })

    await expect(withRequestTimeout(upstream, 1, abortController)).rejects.toMatchObject({
      name: 'RequestTimeoutError',
      timeoutMs: 1,
    })
    expect(abortController.signal.reason).toBeInstanceOf(RequestTimeoutError)
  })
})
