/**
 * Express application.
 *
 * Split out from `server.ts` so it can be mounted in tests without binding a
 * port. Every hardening decision here traces back to a specific failure:
 *
 *  - `trust proxy` was never set, so `express-rate-limit` bucketed every user
 *    on a campus or behind one corporate NAT under a single IP. The feedback
 *    limit of 2 per 15 minutes became "two submissions per quarter, globally".
 *  - CORS was a hardcoded literal list that did not match `config.CORS_ORIGIN`
 *    and included an empty string for socket.io, which is not a valid origin
 *    and breaks origin matching in some clients.
 *  - There was no security headers, no request log, no 404, and no error
 *    middleware — a thrown route handler produced a raw stack trace and a
 *    generic 500 with no request context.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import feedbackRoute from './routes/feedback.route.js';
import { CORS_ORIGIN, IS_PRODUCTION, TRUST_PROXY_HOPS } from './config/index.js';
import { isDbReady } from './db/mongodb.js';
import { clientConfig } from './services/clientConfig.js';
import { logger } from './utils/logger.js';

export function createApp(): Express {
  const app = express();

  // Must be set before the rate limiter, which reads it to resolve the client
  // IP. Without this every proxied request appears to come from the proxy.
  app.set('trust proxy', TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The app is served from a different origin than the API and uses
      // WebRTC data channels, so a strict default CSP needs tuning. These
      // directives are the ones that actually matter for this app.
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          // Blob URLs back received files; workers back thumbnails.
          'worker-src': ["'self'", 'blob:'],
          'connect-src': ["'self'", 'https:', 'ws:', 'wss:'],
          'frame-src': ['https://www.youtube.com', 'https://googleads.g.doubleclick.net'],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'self'"],
          ...(IS_PRODUCTION ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      // We are embedded by nobody, and this breaks Google Fonts.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin, curl and native clients send no Origin header.
        if (!origin) return callback(null, true);
        if (CORS_ORIGIN.includes(origin)) return callback(null, true);
        logger.warn({ origin }, 'blocked cross-origin request');
        return callback(null, false);
      },
      methods: ['GET', 'POST'],
      credentials: true,
      maxAge: 86_400,
    }),
  );

  app.use(express.json({ limit: '32kb' }));

  if (!IS_PRODUCTION) {
    app.use((req, _res, next) => {
      logger.debug({ method: req.method, path: req.path }, 'request');
      next();
    });
  }

  // -- routes ---------------------------------------------------------------

  /**
   * Liveness: is the process up? Deliberately independent of Mongo — a
   * database outage should not make orchestrators kill a perfectly healthy
   * signaling process.
   */
  app.get('/api/v1/health', (_req, res) => {
    res.status(200).json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  /**
   * Readiness: can we actually serve? Used by the Docker healthcheck and load
   * balancers, so it reports dependency state rather than process state.
   */
  app.get('/api/v1/ready', (_req, res) => {
    const db = isDbReady() ? 'connected' : 'absent';
    res.status(200).json({ status: 'ready', database: db });
  });

  /**
   * Client bootstrap: ICE servers and transfer tuning.
   *
   * TURN credentials are frequently short-lived, so serving them from an
   * endpoint lets them rotate without a frontend rebuild. This is a public
   * endpoint by design — TURN credentials are not secrets in the same way an
   * API key is, they are handed to every browser that connects.
   */
  app.get('/api/v1/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json(clientConfig());
  });

  app.use(
    '/api/v1/feedback',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // Keyed on the resolved client IP, which is only meaningful because
      // `trust proxy` is configured above.
      keyGenerator: (req) => req.ip ?? 'unknown',
      handler: (_req, res) => {
        res.status(429).json({
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Too many submissions. Please try again later.',
        });
      },
    }),
    feedbackRoute,
  );

  app.use((_req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'No such endpoint' });
  });

  // -- terminal error handling ----------------------------------------------

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        ok: false,
        code: 'VALIDATION',
        message: 'Validation failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 500;
    if (status >= 500) {
      logger.error({ err, path: req.path, method: req.method }, 'request failed');
    }
    res.status(status).json({
      ok: false,
      code: status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
      message: status >= 500 ? 'Something went wrong. Please try again.' : 'Bad request',
      ...(IS_PRODUCTION ? {} : { debug: err instanceof Error ? err.message : String(err) }),
    });
  });

  return app;
}