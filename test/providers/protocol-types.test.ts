import { describe, expect, it } from 'vitest'
import { toErrorMessage } from '../../src/providers/protocol-types.js'

describe('toErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('returns strings as-is', () => {
    expect(toErrorMessage('plain string')).toBe('plain string')
  })

  it('returns "Unknown error" for null', () => {
    expect(toErrorMessage(null)).toBe('Unknown error')
  })

  it('returns "Unknown error" for undefined', () => {
    expect(toErrorMessage(undefined)).toBe('Unknown error')
  })

  it('JSON-stringifies plain objects', () => {
    expect(toErrorMessage({ code: 429, message: 'rate limited' })).toBe(
      '{"code":429,"message":"rate limited"}',
    )
  })

  it('falls back to String() when JSON.stringify throws', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    // JSON.stringify throws on circular refs, String() returns '[object Object]'
    expect(typeof toErrorMessage(circular)).toBe('string')
    expect(toErrorMessage(circular)).toBeTruthy()
  })
})
