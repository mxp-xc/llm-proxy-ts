export interface Logger {
  info(payload: unknown, msg?: string): void
  warn(payload: unknown, msg?: string): void
  error(payload: unknown, msg?: string): void
  fatal(payload: unknown, msg?: string): void
  child(bindings: Record<string, unknown>): Logger
}
