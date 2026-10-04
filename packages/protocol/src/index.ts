/**
 * @airdelivery/protocol
 *
 * Single source of truth for every message that crosses the AirDelivery
 * signaling boundary. Both `packages/backend` and `packages/frontend` import
 * from here, so a payload change can never drift out of sync on one side.
 *
 * Rules for contributors:
 *  1. Never hand-roll validation in a socket handler — add it here.
 *  2. Every inbound payload needs a schema with an explicit size cap.
 *  3. Every outbound payload that a client depends on needs a schema too, so
 *     the frontend gets types and runtime validation for free.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Flight codes are 6 chars from an unambiguous alphabet. */
  FLIGHT_CODE_LENGTH: 6,
  /** Hard cap on any single signaling frame (SDP is the biggest thing we carry). */
  MAX_SDP_BYTES: 64 * 1024,
  /** Hard cap on a single ICE candidate blob. */
  MAX_CANDIDATE_BYTES: 2 * 1024,
  /** Max simultaneous ICE candidates we will relay for one flight. */
  MAX_CANDIDATES_PER_FLIGHT: 512,
  /** A flight holds at most two peers. */
  MAX_FLIGHT_MEMBERS: 2,
  /** Flight lifetime. Flights are ephemeral by design — nothing is stored. */
  FLIGHT_TTL_MS: 6 * 60 * 60 * 1000,
  /** Largest single transfer we will announce in a flight. */
  MAX_TRANSFER_BYTES: Number.MAX_SAFE_INTEGER,
  /** Cap on a stats delta so one client cannot poison analytics. */
  MAX_STAT_FILES: 100_000,
  MAX_STAT_BYTES: Number.MAX_SAFE_INTEGER,
} as const;

// ---------------------------------------------------------------------------
// Flight codes
// ---------------------------------------------------------------------------

/**
 * Unambiguous alphabet: no 0/O, 1/I/L. A user reading a code off a screen and
 * typing it on a phone keyboard should never be blocked by a glyph guess.
 */
export const FLIGHT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const FlightCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(
    z
      .string()
      .regex(
        new RegExp(`^[${FLIGHT_CODE_ALPHABET}]{${LIMITS.FLIGHT_CODE_LENGTH}}$`),
        'Flight code must be 6 characters',
      ),
  );

/**
 * Normalizes anything a human or a URL might hand us into a canonical code.
 *
 * Accepts lowercase, stray whitespace, dashes and underscores — all of which
 * happen in practice when a code is read aloud, copied from a messaging app,
 * or comes back from a QR/deep link.
 *
 * Control characters are stripped rather than rejected. A QR decoder or a
 * pasted deep link can legitimately deliver a NUL or a newline, and `trim()`
 * only handles the whitespace subset — rejecting the whole code because of one
 * stray byte is a worse outcome than dropping it.
 */
export function normalizeFlightCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    // Map look-alikes people mistype when reading a code off a screen.
    .replace(/O/g, 'Q')
    .replace(/[IL]/g, 'J')
    .replace(/0/g, '2')
    .replace(/1/g, '3');
  return FlightCodeSchema.safeParse(cleaned).success ? cleaned : null;
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A socket.io socket id. */
export const SocketIdSchema = z.string().min(1).max(128);

export const MemberSchema = z.object({
  id: SocketIdSchema,
  name: z.string().min(1).max(64),
});

export type Member = z.infer<typeof MemberSchema>;

/** An SDP blob. Capped, because an unbounded one is a memory-exhaustion vector. */
export const SdpSchema = z.object({
  sdp: z.string().min(1).max(LIMITS.MAX_SDP_BYTES),
  type: z.enum(['offer', 'answer', 'rollback', 'pranswer']).optional(),
});

export type SdpPayload = z.infer<typeof SdpSchema>;

export const IceCandidateSchema = z
  .object({
    candidate: z.string().min(1).max(LIMITS.MAX_CANDIDATE_BYTES),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(255).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .passthrough();

export type IceCandidatePayload = z.infer<typeof IceCandidateSchema>;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** `createFlight` — no payload. */
export const CreateFlightClientSchema = z.tuple([]);

/** `joinFlight` */
export const JoinFlightClientSchema = z.tuple([FlightCodeSchema]);

/** `leaveFlight` — no payload. */
export const LeaveFlightClientSchema = z.tuple([]);

/** `offer` / `answer` / `renegotiate` — (code, sdp) */
export const SignalClientSchema = z.tuple([FlightCodeSchema, SdpSchema]);

/** `ice-candidate` — ({ id, candidate }) */
export const IceClientSchema = z.tuple([
  z.object({
    id: SocketIdSchema,
    candidate: IceCandidateSchema,
  }),
]);

/** `inviteToFlight` — ({ targetId, flightCode }) */
export const InviteClientSchema = z.tuple([
  z.object({
    targetId: SocketIdSchema,
    flightCode: FlightCodeSchema,
  }),
]);

/** `requestToConnect` — (targetId) */
export const RequestConnectClientSchema = z.tuple([SocketIdSchema]);

/** `getNearbyUsers` — no payload. */
export const NearbyUsersClientSchema = z.tuple([]);

/**
 * `updateStats` — anonymous aggregate counters.
 *
 * `bytesTransferred` is BYTES (the old code sent bytes into a field named
 * `Transferred` that was persisted as megabytes — a 1000x analytics error).
 */
export const UpdateStatsClientSchema = z.tuple([
  z.object({
    filesShared: z.number().int().min(0).max(LIMITS.MAX_STAT_FILES).optional(),
    bytesTransferred: z.number().int().min(0).max(LIMITS.MAX_STAT_BYTES).optional(),
    /** Set when the client relayed through TURN — lets us report real speeds. */
    relayed: z.boolean().optional(),
  }),
]);

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export const YourNameServerSchema = z.tuple([
  z.object({ id: SocketIdSchema, name: z.string().min(1).max(64) }),
]);

export const FlightUsersServerSchema = z.tuple([
  z.object({
    code: FlightCodeSchema,
    ownerId: SocketIdSchema,
    members: z.array(MemberSchema).max(LIMITS.MAX_FLIGHT_MEMBERS),
    ownerConnected: z.boolean(),
  }),
]);

export const FlightDeletedServerSchema = z.tuple([]);

export const FlightStartedServerSchema = z.tuple([
  z.object({
    code: FlightCodeSchema,
    members: z.array(MemberSchema).max(LIMITS.MAX_FLIGHT_MEMBERS),
  }),
]);

export const OfferServerSchema = z.tuple([SocketIdSchema, SdpSchema]);

export const AnswerServerSchema = z.tuple([z.object({ id: SocketIdSchema, sdp: SdpSchema })]);

export const IceServerSchema = z.tuple([
  z.object({ id: SocketIdSchema, candidate: IceCandidateSchema }),
]);

export const NearbyUsersServerSchema = z.tuple([z.array(MemberSchema).max(200)]);

export const InvitedToFlightServerSchema = z.tuple([
  z.object({
    flightCode: FlightCodeSchema,
    fromId: SocketIdSchema,
    fromName: z.string().min(1).max(64),
  }),
]);

/** Uniform ack shape. Every callback the client sends gets one of these. */
export const AckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string().max(200),
  }),
]);

export type Ack =
  | { ok: true; code?: string; members?: Member[] }
  | { ok: false; code: string; message: string };

export const ackOk = (extra: Record<string, unknown> = {}): Ack => ({ ok: true, ...extra }) as Ack;

export const ackErr = (code: string, message: string): Ack => ({ ok: false, code, message });

// ---------------------------------------------------------------------------
// Event name registry
// ---------------------------------------------------------------------------

/**
 * Every event name in one place. Import these instead of writing string
 * literals — a typo becomes a type error instead of a silent no-op.
 */
export const EV = {
  // client -> server
  createFlight: 'createFlight',
  joinFlight: 'joinFlight',
  leaveFlight: 'leaveFlight',
  offer: 'offer',
  answer: 'answer',
  iceCandidate: 'ice-candidate',
  inviteToFlight: 'inviteToFlight',
  requestToConnect: 'requestToConnect',
  getNearbyUsers: 'getNearbyUsers',
  updateStats: 'updateStats',

  // server -> client
  yourName: 'yourName',
  flightUsers: 'flightUsers',
  flightDeleted: 'flightDeleted',
  flightStarted: 'flightStarted',
  nearbyUsers: 'nearbyUsers',
  invitedToFlight: 'invitedToFlight',
  error: 'protocolError',
} as const;

export type ServerToClientEvents = {
  [EV.yourName]: (payload: { id: string; name: string }) => void;
  [EV.flightUsers]: (payload: {
    code: string;
    ownerId: string;
    members: Member[];
    ownerConnected: boolean;
  }) => void;
  [EV.flightDeleted]: (reason: FlightDeletedReason) => void;
  [EV.flightStarted]: (payload: { code: string; members: Member[] }) => void;
  [EV.nearbyUsers]: (users: Member[]) => void;
  [EV.invitedToFlight]: (payload: { flightCode: string; fromId: string; fromName: string }) => void;
  [EV.error]: (payload: { code: string; message: string }) => void;
};

export type FlightDeletedReason =
  | 'owner-left'
  | 'peer-left'
  | 'expired'
  | 'replaced'
  | 'server-shutdown';

export type ClientToServerEvents = {
  [EV.createFlight]: (ack: (a: Ack) => void) => void;
  [EV.joinFlight]: (code: string, ack: (a: Ack) => void) => void;
  [EV.leaveFlight]: () => void;
  [EV.offer]: (code: string, sdp: SdpPayload) => void;
  [EV.answer]: (code: string, sdp: SdpPayload) => void;
  [EV.iceCandidate]: (payload: { id: string; candidate: IceCandidatePayload }) => void;
  [EV.inviteToFlight]: (
    payload: { targetId: string; flightCode: string },
    ack: (a: Ack) => void,
  ) => void;
  [EV.requestToConnect]: (targetId: string, ack: (a: Ack) => void) => void;
  [EV.getNearbyUsers]: () => void;
  [EV.updateStats]: (payload: {
    filesShared?: number;
    bytesTransferred?: number;
    relayed?: boolean;
  }) => void;
};

// ---------------------------------------------------------------------------
// ICE / TURN configuration handed to clients
// ---------------------------------------------------------------------------

export const IceServerConfigSchema = z.object({
  urls: z.string().min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type IceServerConfig = z.infer<typeof IceServerConfigSchema>;

/**
 * Served from `GET /api/v1/config`. TURN is entirely env-driven — see
 * `.env.example`. When no TURN is configured the client still works, but it
 * cannot traverse symmetric NAT, so the UI shows a "relay unavailable" notice
 * rather than silently failing on campus/office networks.
 */
export const ClientConfigSchema = z.object({
  iceServers: z.array(IceServerConfigSchema).min(1),
  /** True when at least one TURN server is configured. */
  turnAvailable: z.boolean(),
  /** Server-advertised chunk sizing hints, tuned per deployment. */
  transfer: z.object({
    maxChunkBytes: z.number().int().positive(),
    highWaterMarkBytes: z.number().int().positive(),
    parallelChannels: z.number().int().min(1).max(8),
  }),
  limits: z.object({
    maxFlightMembers: z.number().int().positive(),
    flightTtlMs: z.number().int().positive(),
  }),
});

export type ClientConfig = z.infer<typeof ClientConfigSchema>;

// ---------------------------------------------------------------------------
// Flight transfer wire format (binary, documented for contributors)
// ---------------------------------------------------------------------------
//
// Chunk packet — little-endian, no padding, sent over the bulk data channel:
//
//   offset  size  field
//   0       4     u32   sessionId      (monotonic u16, assigned per transfer)
//   4       2     u16   payloadLength
//   6       1     u8    flags          bit0 = lz4 compressed
//   7       2     u16   sequence       (per session, starts at 0)
//   9       2     u16   crc32          (of the payload, post-decompression)
//   11      ...   payload
//
// Why a 2-byte session id instead of the transfer's UUID: the old format spent
// 45 bytes of header per chunk repeating a 36-char UUID, and allocated a fresh
// TextEncoder per chunk. At 4000 chunks/sec that is real GC pressure for
// nothing.

export const CHUNK_HEADER_BYTES = 11;
export const CHUNK_FLAG_LZ4 = 1 << 0;
