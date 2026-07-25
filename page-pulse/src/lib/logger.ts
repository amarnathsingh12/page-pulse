import pino, { type LoggerOptions } from 'pino';
import type { Config } from '../config/env';

const SECRET_PARAM = /^(token|key|apikey|api_key|signature|sig|password|access_token|auth)$/i;

export function loggerOptions(config: Config): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    base: { service: 'page-pulse', env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
    },
    transport: config.LOG_PRETTY ? { target: 'pino-pretty' } : undefined,
  };
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(k)) u.searchParams.set(k, '***');
    }
    return u.toString();
  } catch {
    return '[unparseable-url]';
  }
}
