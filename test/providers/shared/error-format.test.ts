import { describe, expect, it } from 'vitest'
import {
  anthropicErrorFormat,
  openAIErrorFormat,
} from '../../../src/providers/shared/error-format.js'

describe('vision input error formatting', () => {
  it('formats OpenAI-compatible unsupported vision input errors', () => {
    expect(openAIErrorFormat.unsupportedVisionInput()).toEqual({
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_vision_input',
          message: 'Vision input is not supported by the selected model',
        },
      },
      status: 400,
    })
  })

  it('formats Anthropic unsupported vision input errors', () => {
    expect(anthropicErrorFormat.unsupportedVisionInput()).toEqual({
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_vision_input',
          message: 'Vision input is not supported by the selected model',
        },
      },
      status: 400,
    })
  })

  it('formats OpenAI-compatible internal errors', () => {
    expect(openAIErrorFormat.internal()).toEqual({
      body: {
        error: {
          type: 'internal_error',
          code: 'internal_server_error',
          message: 'Internal server error',
        },
      },
      status: 500,
    })
  })

  it('formats Anthropic internal errors', () => {
    expect(anthropicErrorFormat.internal()).toEqual({
      body: {
        type: 'error',
        error: { type: 'api_error', message: 'Internal server error' },
      },
      status: 500,
    })
  })
})
