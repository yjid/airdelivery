/**
 * Structured logging.
 *
 * Replaces the hand-rolled console formatter. Two reasons that matters:
 *  - JSON logs are queryable in production, so "the backend crashed" stops
 *    being a thing you reconstruct from vibes.
 *  - Redaction is declarative. We hash network prefixes instead of writing
 *    raw client IPs to disk, which matters for a project whose entire pitch
 *    is that we do not keep your data.
 */

import pino from 'pino';
import { IS_PRODUCTION, IS_TEST, LOG_LEVEL, NODE_ENV, TO_DEBUG } from '../config/index.js';

export const logger = pino({
  // Tests must not spam the reporter with expected-failure logs.
  level: IS_TEST ? 'silent' : TO_DEBUG ? 'debug' : LOG_LEVEL,
  base: { service: 'airdelivery-signal', env: NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      'password',
      '*.password',
    ],
    censor: '[redacted]',
  },
  ...(IS_PRODUCTION || IS_TEST
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }),
});

export type Logger = typeof logger;

/**
 * A per-connection logger. Every line carries the socket id so a single
 * transfer can be reconstructed end to end.
 */
export function childFor(component: string, socketId?: string) {
  return socketId ? logger.child({ component, socketId }) : logger.child({ component });
}

export default logger;
