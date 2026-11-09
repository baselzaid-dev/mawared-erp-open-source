import { redactMetadata } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppLogEvent {
  level: LogLevel;
  event: string;
  timestamp: string;
  service: string;
  environment: string;
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  principalType?: string;
  actorId?: string;
  companyId?: string;
  errorCode?: string;
  errorClass?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface AppLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface AppLoggerOptions {
  service?: string;
  environment?: string;
  isProduction: boolean;
  jsonOutput?: boolean;
  sink?: (line: string, level: LogLevel) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

function formatReadable(event: AppLogEvent): string {
  const parts = [
    event.timestamp,
    event.level.toUpperCase(),
    event.event,
    event.requestId ? `requestId=${event.requestId}` : null,
    event.method && event.route ? `${event.method} ${event.route}` : null,
    event.status != null ? `status=${event.status}` : null,
    event.durationMs != null ? `durationMs=${event.durationMs}` : null,
    event.errorCode ? `errorCode=${event.errorCode}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

function writeEvent(
  options: AppLoggerOptions,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (options.isProduction && level === 'debug') return;

  const sanitized = redactMetadata(fields) as Record<string, unknown>;
  const payload: AppLogEvent = {
    level,
    event,
    timestamp: new Date().toISOString(),
    service: options.service ?? 'mawared-backend',
    environment: options.environment ?? (options.isProduction ? 'production' : 'development'),
    ...(sanitized.requestId != null ? { requestId: String(sanitized.requestId) } : {}),
    ...(sanitized.method != null ? { method: String(sanitized.method) } : {}),
    ...(sanitized.route != null ? { route: String(sanitized.route) } : {}),
    ...(sanitized.status != null ? { status: Number(sanitized.status) } : {}),
    ...(sanitized.durationMs != null ? { durationMs: Number(sanitized.durationMs) } : {}),
    ...(sanitized.principalType != null ? { principalType: String(sanitized.principalType) } : {}),
    ...(sanitized.actorId != null ? { actorId: String(sanitized.actorId) } : {}),
    ...(sanitized.companyId != null ? { companyId: String(sanitized.companyId) } : {}),
    ...(sanitized.errorCode != null ? { errorCode: String(sanitized.errorCode) } : {}),
    ...(sanitized.errorClass != null ? { errorClass: String(sanitized.errorClass) } : {}),
    ...(sanitized.errorMessage != null ? { errorMessage: String(sanitized.errorMessage) } : {}),
  };

  const metadataKeys = Object.keys(sanitized).filter((key) => !([
    'requestId',
    'method',
    'route',
    'status',
    'durationMs',
    'principalType',
    'actorId',
    'companyId',
    'errorCode',
    'errorClass',
    'errorMessage',
  ] as const).includes(key as any));
  if (metadataKeys.length > 0) {
    payload.metadata = Object.fromEntries(metadataKeys.map((key) => [key, sanitized[key]]));
  }

  const useJson = options.jsonOutput ?? options.isProduction;
  const line = useJson ? JSON.stringify(payload) : formatReadable(payload);
  (options.sink ?? defaultSink)(line, level);
}

export function createAppLogger(options: AppLoggerOptions): AppLogger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    writeEvent(options, level, event, fields ?? {});
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export function shouldEmitLevel(level: LogLevel, isProduction: boolean): boolean {
  if (isProduction && level === 'debug') return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER.info;
}
