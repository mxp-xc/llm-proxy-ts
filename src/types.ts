export interface Logger {
  info(payload: unknown, msg?: string): void
  warn(payload: unknown, msg?: string): void
  error(payload: unknown, msg?: string): void
  fatal(payload: unknown, msg?: string): void
  child(bindings: Record<string, unknown>): Logger
}

/** No-op Logger that discards all output. Shared across modules and tests. */
export const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger
  },
}
