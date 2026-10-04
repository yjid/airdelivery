/**
 * Environment configuration.
 *
 * Every value is validated once, at import time, and the process refuses to
 * start on a misconfiguration rather than limping along in a half-broken
 * state. Nothing here reads `process.env` at call time — that was how
 * `NODE_ENV` ended up meaning the opposite of what its name says.
 */

import { z } from 'zod';

const boolish = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const int = (def: number, min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
      return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : def;
    });

const csv = (def: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : def,
    );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(5500, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DEBUG: boolish(false),

  DB_URI: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),

  CORS_ORIGIN: csv(['http://localhost:3000']),

  /**
   * Number of reverse proxies in front of us. `1` on Cloudflare/Fly/one nginx.
   * Without this, express-rate-limit buckets every user under one IP and
   * `x-forwarded-for` is ignored — which is exactly the campus/office failure.
   */
  TRUST_PROXY_HOPS: int(0, 0, 10),

  /**
   * Only trust `cf-connecting-ip` / `x-forwarded-for` when we are actually
   * behind a proxy. Trusting them unconditionally lets any client spoof its
   * address and poison nearby-user buckets.
   */
  TRUST_PROXY: boolish(false),

  STUN_URLS: csv([
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ]),

  /** Fully env-driven TURN. No default — see .env.example. */
  TURN_URLS: csv([]),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),

  /** Transfer tuning hints advertised to clients. */
  MAX_CHUNK_BYTES: int(256 * 1024, 16 * 1024, 1024 * 1024),
  HIGH_WATER_MARK_BYTES: int(8 * 1024 * 1024, 1024 * 1024, 128 * 1024 * 1024),
  PARALLEL_CHANNELS: int(2, 1, 8),

  /** Socket.IO transport order. Polling must stay enabled for office proxies. */
  SOCKET_TRANSPORTS: csv(['websocket', 'polling']),
  SOCKET_MAX_BUFFER_BYTES: int(256 * 1024, 16 * 1024, 4 * 1024 * 1024),
  SOCKET_PING_INTERVAL_MS: int(20_000, 5_000, 120_000),
  SOCKET_PING_TIMEOUT_MS: int(20_000, 5_000, 120_000),

  /** Per-socket event budget, to stop a single client starving the loop. */
  RATE_LIMIT_WINDOW_MS: int(10_000, 1_000, 300_000),
  RATE_LIMIT_MAX_EVENTS: int(300, 10, 100_000),

  /** Graceful shutdown budget before we force the process down. */
  SHUTDOWN_TIMEOUT_MS: int(10_000, 1_000, 120_000),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

const env = parsed.data;

export const NODE_ENV = env.NODE_ENV;
export const IS_PRODUCTION = NODE_ENV === 'production';
export const IS_TEST = NODE_ENV === 'test';
export const TO_DEBUG = env.DEBUG;

export const PORT = env.PORT;
export const LOG_LEVEL = env.LOG_LEVEL;
export const DB_URI = env.DB_URI;
export const CORS_ORIGIN = env.CORS_ORIGIN;

export const TRUST_PROXY_HOPS = env.TRUST_PROXY_HOPS;
export const TRUST_PROXY = env.TRUST_PROXY || TRUST_PROXY_HOPS > 0;

/**
 * Whether we should believe forwarded-for style headers.
 *
 * Cloudflare always sets `cf-connecting-ip`, but only trust it behind a proxy
 * we control, otherwise any client can claim any address.
 */
export const TRUST_FORWARDED_HEADERS = TRUST_PROXY;

export const STUN_URLS = env.STUN_URLS;
export const TURN_URLS = env.TURN_URLS;
export const TURN_USERNAME = env.TURN_USERNAME;
export const TURN_CREDENTIAL = env.TURN_CREDENTIAL;

/** At least one TURN entry must have credentials to be usable. */
export const TURN_AVAILABLE = TURN_URLS.length > 0 && Boolean(TURN_USERNAME);

export const MAX_CHUNK_BYTES = env.MAX_CHUNK_BYTES;
export const HIGH_WATER_MARK_BYTES = env.HIGH_WATER_MARK_BYTES;
export const PARALLEL_CHANNELS = env.PARALLEL_CHANNELS;

export const SOCKET_TRANSPORTS = env.SOCKET_TRANSPORTS as ('websocket' | 'polling')[];
export const SOCKET_MAX_BUFFER_BYTES = env.SOCKET_MAX_BUFFER_BYTES;
export const SOCKET_PING_INTERVAL_MS = env.SOCKET_PING_INTERVAL_MS;
export const SOCKET_PING_TIMEOUT_MS = env.SOCKET_PING_TIMEOUT_MS;

export const RATE_LIMIT_WINDOW_MS = env.RATE_LIMIT_WINDOW_MS;
export const RATE_LIMIT_MAX_EVENTS = env.RATE_LIMIT_MAX_EVENTS;

export const SHUTDOWN_TIMEOUT_MS = env.SHUTDOWN_TIMEOUT_MS;

/**
 * The ICE server list handed to browsers. Ordered so that host candidates win
 * on a LAN (hotspot / laptop-to-phone) and TURN is only used as a last resort,
 * which is what keeps local transfers at LAN speed.
 */
export function buildIceServers() {
  const servers: {
    urls: string | string[];
    username?: string;
    credential?: string;
  }[] = [{ urls: STUN_URLS }];

  if (TURN_AVAILABLE) {
    servers.push({
      urls: TURN_URLS,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    });
  }

  return servers;
}