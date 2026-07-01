import type { ProtocolStrategy } from '../shared/strategy.js'
import { anthropicErrorFormat } from '../shared/error-format.js'
import {
  validateAnthropicMessagesRequest,
  mapAnthropicMessagesRequestToAISDKInput,
} from './protocol.js'
import { renderAnthropicMessage, renderAnthropicMessageSSE } from './renderer.js'
import type { AnthropicMessagesRequest } from './protocol.js'
import type { AnthropicSSEData, AnthropicMessageResponse } from './types.js'

export const anthropicStrategy: ProtocolStrategy<
  AnthropicMessagesRequest,
  AnthropicSSEData,
  AnthropicMessageResponse
> = {
  validate: validateAnthropicMessagesRequest,
  validationMessage: 'Invalid Anthropic Messages request',
  getModel: (req) => req.model,
  isStream: (req) => req.stream ?? false,
  mapToAISDKInput: mapAnthropicMessagesRequestToAISDKInput,
  renderResult: renderAnthropicMessage,
  renderStreamSSE: renderAnthropicMessageSSE,
  formatErrors: anthropicErrorFormat,
}
