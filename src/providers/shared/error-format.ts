import type { RoutingError } from '../../routing.js'
import { isRecord, toErrorMessage } from '../protocol-types.js'

/** OpenAI 风格错误响应体 */
export interface OpenAIErrorBody {
  error: {
    type: string
    code: string
    message: string
    loginUrl?: string
  }
}

/** Anthropic 风格错误响应体 */
export interface AnthropicErrorBody {
  type: 'error'
  error: {
    type: string
    code?: string
    message: string
    loginUrl?: string
  }
}

/**
 * 协议错误格式化器：按协议风格格式化各类错误响应。
 * OpenAI 兼容协议和 Anthropic 协议的错误格式不同。
 */
export interface ProtocolErrorFormatter<TBody = OpenAIErrorBody | AnthropicErrorBody> {
  /** 请求验证失败 — 可传入协议特定的消息文本 */
  validation(message?: string): { body: TBody; status: number }
  /** 选中模型不支持请求中的视觉输入 */
  unsupportedVisionInput(): { body: TBody; status: number }
  /** proxy 内部错误 */
  internal(): { body: TBody; status: number }
  /** 模型路由失败（模型不存在） */
  routing(error: RoutingError): { body: TBody; status: number }
  /** OAuth 认证失败（需要登录） */
  oauth(message: string, loginUrl: string): { body: TBody; status: number }
  /** 流首包检查发现限流错误 */
  rateLimit(errorBody: unknown, errorStatus?: number): { body: TBody; status: number }
  /** 上游超时 */
  timeout(): { body: TBody; status: number }
  /** 上游请求失败（通用错误） */
  upstream(): { body: TBody; status: number }
}

/**
 * OpenAI 风格错误格式化器。
 * openai-compatible 和 openai-responses 共用同一风格。
 */
export const openAIErrorFormat: ProtocolErrorFormatter<OpenAIErrorBody> = {
  validation(message?: string) {
    return {
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'invalid_request',
          message: message ?? 'Invalid request',
        },
      },
      status: 400,
    }
  },

  unsupportedVisionInput() {
    return {
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_vision_input',
          message: 'Vision input is not supported by the selected model',
        },
      },
      status: 400,
    }
  },

  internal() {
    return {
      body: {
        error: {
          type: 'internal_error',
          code: 'internal_server_error',
          message: 'Internal server error',
        },
      },
      status: 500,
    }
  },

  routing(error: RoutingError) {
    return {
      body: {
        error: {
          type: 'invalid_request_error',
          code: error.code,
          message: error.message,
        },
      },
      status: error.status,
    }
  },

  oauth(message: string, loginUrl: string) {
    return {
      body: {
        error: {
          type: 'auth_required',
          code: 'oauth_login_needed',
          message,
          loginUrl,
        },
      },
      status: 503,
    }
  },

  rateLimit(errorBody: unknown, errorStatus?: number) {
    // 如果 errorBody 已经是合法的 OpenAI 错误格式，直接透传
    if (
      isRecord(errorBody) &&
      isRecord(errorBody['error']) &&
      typeof errorBody['error']?.message === 'string'
    ) {
      return { body: errorBody as unknown as OpenAIErrorBody, status: errorStatus ?? 429 }
    }
    // 否则构造标准 OpenAI 错误体
    return {
      body: {
        error: {
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
          message: toErrorMessage(errorBody),
        },
      },
      status: errorStatus ?? 429,
    }
  },

  timeout() {
    return {
      body: {
        error: {
          type: 'upstream_error',
          code: 'upstream_request_timeout',
          message: 'Upstream provider request timed out',
        },
      },
      status: 504,
    }
  },

  upstream() {
    return {
      body: {
        error: {
          type: 'upstream_error',
          code: 'upstream_request_failed',
          message: 'Upstream provider request failed',
        },
      },
      status: 502,
    }
  },
}

/**
 * Anthropic 风格错误格式化器。
 */
export const anthropicErrorFormat: ProtocolErrorFormatter<AnthropicErrorBody> = {
  validation(message?: string) {
    return {
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: message ?? 'Invalid request' },
      },
      status: 400,
    }
  },

  unsupportedVisionInput() {
    return {
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_vision_input',
          message: 'Vision input is not supported by the selected model',
        },
      },
      status: 400,
    }
  },

  internal() {
    return {
      body: {
        type: 'error',
        error: { type: 'api_error', message: 'Internal server error' },
      },
      status: 500,
    }
  },

  routing(error: RoutingError) {
    return {
      body: {
        type: 'error',
        error: {
          type: 'not_found_error',
          message: error.message,
        },
      },
      status: error.status,
    }
  },

  oauth(message: string, loginUrl: string) {
    return {
      body: {
        type: 'error',
        error: { type: 'authentication_error', message, loginUrl },
      },
      status: 503,
    }
  },

  rateLimit(errorBody: unknown, errorStatus?: number) {
    return {
      body: {
        type: 'error',
        error: { type: 'rate_limit_error', message: JSON.stringify(errorBody) },
      },
      status: errorStatus ?? 429,
    }
  },

  timeout() {
    return {
      body: {
        type: 'error',
        error: { type: 'timeout_error', message: 'Upstream provider request timed out' },
      },
      status: 504,
    }
  },

  upstream() {
    return {
      body: {
        type: 'error',
        error: { type: 'api_error', message: 'Upstream provider request failed' },
      },
      status: 502,
    }
  },
}
