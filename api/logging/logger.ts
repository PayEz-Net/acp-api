export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogModule = 'auth' | 'mail-proxy' | 'sse' | 'lifecycle' | 'party' | 'autonomy' | 'kanban' | 'chat' | 'server' | 'config' | 'shutdown' | 'byok';

const LEVEL_PRIORITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: LogModule;
  message: string;
  data?: Record<string, unknown>;
}

// Case-insensitive deny-list. Any `data` field whose key (at any nesting depth)
// matches one of these is masked to '[REDACTED]' before emit. Protects the
// BYOK privacy-copy claim on /privacy and the §11 audit envelope: provider
// request/response bodies and auth material never reach stdout.
const REDACT_FIELDS: ReadonlySet<string> = new Set([
  'key',
  'api_key',
  'apikey',
  'authorization',
  'x-api-key',
  'x-anthropic-api-key',
  'x-moonshot-api-key',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'client_secret',
]);

const REDACTED = '[REDACTED]' as const;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_FIELDS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

function emit(entry: LogEntry): void {
  const safe: LogEntry = entry.data
    ? { ...entry, data: redact(entry.data) as Record<string, unknown> }
    : entry;
  const line = JSON.stringify(safe);
  if (safe.level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export function log(level: LogLevel, module: LogModule, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  emit({
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...(data ? { data } : {}),
  });
}

export const logger = {
  error: (module: LogModule, message: string, data?: Record<string, unknown>) => log('error', module, message, data),
  warn: (module: LogModule, message: string, data?: Record<string, unknown>) => log('warn', module, message, data),
  info: (module: LogModule, message: string, data?: Record<string, unknown>) => log('info', module, message, data),
  debug: (module: LogModule, message: string, data?: Record<string, unknown>) => log('debug', module, message, data),
};

/**
 * Express middleware for request logging.
 * Logs: method, path, status, duration, requestId.
 */
export function requestLogger() {
  return (req: any, res: any, next: () => void): void => {
    const start = performance.now();
    const originalEnd = res.end;

    res.end = function (...args: any[]) {
      const duration = Math.round(performance.now() - start);
      log('info', 'server', `${req.method} ${req.path} ${res.statusCode}`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        request_id: req.requestId,
      });
      return originalEnd.apply(res, args);
    };

    next();
  };
}
