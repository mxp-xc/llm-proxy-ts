import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pino from 'pino';
import pretty from 'pino-pretty';

// --- Environment variable configuration ---

const LOG_LEVEL = process.env.LLM_PROXY_LOG_LEVEL ?? 'info';
const LOG_DIR = process.env.LLM_PROXY_LOG_DIR ?? resolve(process.cwd(), 'logs');
const LOG_FORMAT = process.env.LLM_PROXY_LOG_FORMAT ?? 'pretty';
const LOG_RETENTION_DAYS = 7;

// Note: dateformat (used by pino-pretty) has counter-intuitive tokens:
//   mm = month (zero-padded), MM = minute (zero-padded)
// So the correct format for "2024-06-04 19:01:27" is 'yyyy-mm-dd HH:MM:ss'
const PRETTY_TIME_FORMAT = 'SYS:yyyy-mm-dd HH:MM:ss';

// --- Redaction ---

const secretKeys = new Set(['apikey', 'api_key', 'authorization', 'x-api-key', 'proxy-authorization']);

// --- Shared pretty format config ---

const prettyMessageFormat =
  '{msg}' +
  '{if requestId} requestId={requestId}{end}' +
  '{if method} method={method}{end}' +
  '{if path} path={path}{end}' +
  '{if status} status={status}{end}' +
  '{if durationMs} durationMs={durationMs}{end}' +
  '{if provider} provider={provider}{end}' +
  '{if keyIndex} keyIndex={keyIndex}{end}' +
  '{if keyCount} keyCount={keyCount}{end}' +
  '{if host} host={host}{end}' +
  '{if port} port={port}{end}';

const basePrettyOptions = {
  translateTime: PRETTY_TIME_FORMAT,
  ignore: 'pid,hostname',
  singleLine: true,
  hideObject: true,
  messageFormat: prettyMessageFormat,
};

// --- Log file rotation & cleanup ---

function getLogFileName(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `llm-proxy.${y}-${m}-${d}.log`;
}

export function cleanOldLogs(logDir: string = LOG_DIR, retentionDays: number = LOG_RETENTION_DAYS): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    for (const entry of readdirSync(logDir)) {
      const filePath = resolve(logDir, entry);
      try {
        const stat = statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
        }
      } catch {
        // Skip files that disappear or are inaccessible
      }
    }
  } catch {
    // Directory may not exist yet — nothing to clean
  }
}

// --- Logger factory ---

export function createLogger(options?: pino.LoggerOptions): pino.Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: LOG_LEVEL,
    name: 'llm-proxy',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['apiKey', '*.apiKey', 'authorization', '*.authorization'],
      censor: '[REDACTED]',
    },
    ...options,
  };

  try {
    const streams: pino.StreamEntry[] = [];

    // Stdout: pino-pretty as a direct sync stream (main thread)
    if (LOG_FORMAT === 'pretty') {
      streams.push({
        level: LOG_LEVEL as pino.Level,
        stream: pretty({ ...basePrettyOptions, colorize: true, sync: true }),
      });
    } else {
      streams.push({ level: LOG_LEVEL as pino.Level, stream: process.stdout });
    }

    // File: pino-pretty (no color) writes to a file stream.
    // Daily rotation is achieved by including the date in the filename.
    // Old log files are cleaned up on startup via cleanOldLogs().
    const logFilePath = resolve(LOG_DIR, getLogFileName());
    mkdirSync(resolve(LOG_DIR), { recursive: true });
    const fileStream = createWriteStream(logFilePath, { flags: 'a' });

    streams.push({
      level: 'trace' as pino.Level,
      stream: pretty({ ...basePrettyOptions, colorize: false, destination: fileStream }),
    });

    return pino(pinoOptions, pino.multistream(streams));
  } catch {
    // Fallback: if transport pipeline fails (e.g. worker thread unavailable),
    // fall back to simple stdout logger so the server can still start.
    return pino({
      level: LOG_LEVEL,
      name: 'llm-proxy',
      ...options,
    });
  }
}

export const logger = createLogger();

// Clean old log files on startup
cleanOldLogs();

// --- Utility exports (unchanged) ---

export function requestId(): string {
  return randomUUID();
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        secretKeys.has(key.toLowerCase()) ? '[REDACTED]' : redact(child),
      ]),
    );
  }

  return value;
}

export function safeProxyHost(proxyUrl: string): string {
  return new URL(proxyUrl).host;
}
