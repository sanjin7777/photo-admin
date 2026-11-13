/** 轻量结构化日志：统一带 traceId，便于和前端 X-Trace-Id / audit_logs.trace_id 串起来。 */
import { getTraceId } from '../middleware/context';
import { env } from '../config/env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const WEIGHT: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = env.LOG_LEVEL;
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

interface LogPayload {
  ts: string;
  level: LogLevel;
  message: string;
  traceId: string;
  [key: string]: unknown;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (WEIGHT[level] < WEIGHT[currentLevel]) return;
  const payload: LogPayload = {
    ts: new Date().toISOString(),
    level,
    message,
    traceId: getTraceId(),
    ...meta,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};
