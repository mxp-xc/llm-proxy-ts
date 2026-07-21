import type { ProtocolStrategy, ProtocolVisionInputFilter } from '../shared/strategy.js'
import { anthropicErrorFormat } from '../shared/error-format.js'
import {
  validateAnthropicMessagesRequest,
  mapAnthropicMessagesRequestToAISDKInput,
} from './protocol.js'
import { renderAnthropicMessage, renderAnthropicMessageSSE } from './renderer.js'
import {
  applyUnsupportedAnthropicVisionInput,
  planUnsupportedAnthropicVisionInput,
} from './vision-input.js'
import type { AnthropicMessagesRequest } from './protocol.js'
import type { AnthropicSSEData, AnthropicMessageResponse } from './types.js'

export const anthropicStrategy: ProtocolStrategy<
  AnthropicMessagesRequest,
  AnthropicSSEData,
  AnthropicMessageResponse
> &
  ProtocolVisionInputFilter = {
  visionInputProtocol: 'anthropic-messages',
  planUnsupportedVisionInput: planUnsupportedAnthropicVisionInput,
  applyUnsupportedVisionInput: applyUnsupportedAnthropicVisionInput,
  validate: validateAnthropicMessagesRequest,
  validationMessage: 'Invalid Anthropic Messages request',
  getModel: (req) => req.model,
  isStream: (req) => req.stream ?? false,
  mapToAISDKInput: mapAnthropicMessagesRequestToAISDKInput,
  renderResult: renderAnthropicMessage,
  renderStreamSSE: renderAnthropicMessageSSE,
  formatErrors: anthropicErrorFormat,
}
