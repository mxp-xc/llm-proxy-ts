import type { RoutingError } from '../../routing.js'

/**
 * 协议错误格式化器：按协议风格格式化各类错误响应。
 * OpenAI 兼容协议和 Anthropic 协议的错误格式不同。
 */
export interface ProtocolErrorFormatter {
  /** 请求验证失败 */
  validation(): { body: unknown; status: number }
  /** 模型路由失败（模型不存在） */
  routing(error: RoutingError): { body: unknown; status: number }
  /** OAuth 认证失败（需要登录） */
  oauth(message: string, loginUrl: string): { body: unknown; status: number }
  /** 流首包检查发现限流错误 */
  rateLimit(errorBody: unknown, errorStatus?: number): { body: unknown; status: number }
  /** 上游超时 */
  timeout(): { body: unknown; status: number }
  /** 上游请求失败（通用错误） */
  upstream(): { body: unknown; status: number }
}

/**
 * OpenAI 风格错误格式化器。
 * openai-compatible 和 openai-responses 共用同一风格。
 */
export const openAIErrorFormat: ProtocolErrorFormatter = {
  validation() {
    return {
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'invalid_request',
          message: 'Invalid request',
        },
      },
      status: 400,
    }
  },

  routing(error: RoutingError) {
    return { body: error.toResponse(), status: error.status }
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
    return { body: errorBody, status: errorStatus ?? 429 }
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
export const anthropicErrorFormat: ProtocolErrorFormatter = {
  validation() {
    return {
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Invalid request' },
      },
      status: 400,
    }
  },

  routing(error: RoutingError) {
    return {
      body: {
        type: 'error',
        error: {
          type: 'not_found_error',
          message: error.toResponse().error?.message ?? 'Model not found',
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
