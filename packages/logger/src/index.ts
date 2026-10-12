import pino from 'pino';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  service: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  pretty?: boolean;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const instance = pino({
    level: options.level ?? 'info',
    base: { service: options.service },
    ...(options.pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });

  return {
    debug: (msg, meta) => instance.debug(meta ?? {}, msg),
    info: (msg, meta) => instance.info(meta ?? {}, msg),
    warn: (msg, meta) => instance.warn(meta ?? {}, msg),
    error: (msg, meta) => instance.error(meta ?? {}, msg),
  };
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
