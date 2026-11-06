import { pino, type Logger, type LoggerOptions } from 'pino';

/** Parámetros de query cuyo valor nunca debe aparecer en los logs. */
const SECRET_QUERY_KEYS = new Set(['token', 'access_token', 'hub.verify_token', 'client_secret']);

/** Sustituye por [REDACTED] los valores de parámetros sensibles de una URL relativa o absoluta. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const path = url.slice(0, q);
  const params = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // clave mal codificada: se deja tal cual
      }
      return SECRET_QUERY_KEYS.has(key.toLowerCase()) ? `${rawKey}=[REDACTED]` : pair;
    });
  return `${path}?${params.join('&')}`;
}

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { service: 'ig-comments' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-hub-signature-256"]',
        '*.access_token',
        '*.accessToken',
        '*.apiKey',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req(req: { method?: string; url?: string; id?: unknown }) {
        return { id: req.id, method: req.method, url: req.url ? redactUrl(req.url) : req.url };
      },
    },
  };
}

export function createLogger(level: string): Logger {
  return pino(loggerOptions(level));
}

export type { Logger };
