/**
 * Client bootstrap configuration.
 *
 * Served from `GET /api/v1/config`.
 *
 * TURN is entirely env-driven with no default (see `.env.example`). When none
 * is configured the app still works — it just cannot traverse symmetric NAT,
 * which means campus and corporate networks will fail to connect. Rather than
 * failing silently, the client shows a "relay unavailable" notice so a user
 * knows to try a different network instead of refreshing forever.
 */

import {
  buildIceServers,
  HIGH_WATER_MARK_BYTES,
  MAX_CHUNK_BYTES,
  PARALLEL_CHANNELS,
  TURN_AVAILABLE,
  TURN_CREDENTIAL,
  TURN_URLS,
  TURN_USERNAME,
} from '../config/index.js';
import {
  LIMITS,
  type ClientConfig,
  type IceServerConfig,
} from '@airdelivery/protocol';

let cached: ClientConfig | null = null;

/**
 * Host candidates are tried first, so a hotspot or office LAN connects
 * directly at LAN speed and never touches a relay. TURN is only reached when
 * the direct path genuinely fails, which is what keeps local transfers fast.
 */
export function clientConfig(): ClientConfig {
  if (cached) return cached;

  const iceServers: IceServerConfig[] = buildIceServers().map((server) => {
    const urls = Array.isArray(server.urls) ? server.urls.join(',') : server.urls;
    const entry: IceServerConfig = { urls };
    if (server.username) entry.username = server.username;
    if (server.credential) entry.credential = server.credential;
    return entry;
  });

  cached = {
    iceServers,
    turnAvailable: TURN_AVAILABLE,
    transfer: {
      maxChunkBytes: MAX_CHUNK_BYTES,
      highWaterMarkBytes: HIGH_WATER_MARK_BYTES,
      parallelChannels: PARALLEL_CHANNELS,
    },
    limits: {
      maxFlightMembers: LIMITS.MAX_FLIGHT_MEMBERS,
      flightTtlMs: LIMITS.FLIGHT_TTL_MS,
    },
  };

  if (!TURN_AVAILABLE && TURN_URLS.length > 0) {
    // Misconfiguration worth surfacing loudly in the logs rather than leaving
    // an operator to wonder why campus users cannot connect.
    logger.warn({ turnUrls: TURN_URLS }, 'TURN_URLS set but TURN_USERNAME missing — TURN disabled');
  }

  return cached;
}

export function resetClientConfigCache(): void {
  cached = null;
}

import { logger } from '../utils/logger.js';