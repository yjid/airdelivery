/**
 * Socket.IO event handlers.
 *
 * Three invariants this module exists to enforce:
 *
 *  1. VALIDATE. Every inbound payload goes through a schema in
 *     `@airdelivery/protocol`. An unknown or malformed payload is rejected
 *     before it can be logged, stored, or forwarded.
 *
 *  2. AUTHORIZE. The old server had no membership checks on `offer`,
 *     `answer`, `ice-candidate` or `joinFlight`. Any connected client could
 *     overwrite any flight's stored SDP — hijacking someone else's transfer —
 *     or join any room by guessing a 6-character code. Every signaling event
 *     now checks membership, and mutating events check ownership.
 *
 *  3. NEVER THROW ESCAPE. Handlers are registered through `guard.on`, so a
 *     throw is logged and answered, never fatal.
 */

import { Server, Socket } from 'socket.io';
import {
  EV,
  FlightCodeSchema,
  IceCandidateSchema,
  InviteClientSchema,
  JoinFlightClientSchema,
  LIMITS,
  SdpSchema,
  SocketIdSchema,
  UpdateStatsClientSchema,
  ackErr,
  ackOk,
  type Ack,
  type FlightDeletedReason,
  type Member,
} from '@airdelivery/protocol';
import { onBounded } from './guard.js';
import { FlightManager } from '../services/FlightManager.js';
import { UserManager } from '../services/UserManager.js';
import { StatManager } from '../services/StatManager.js';
import { generateUniqueCode } from '../utils/code.js';
import { classifyAddress, resolveClientAddress } from '../utils/net.js';
import { getRandomName } from '../utils/names.js';
import { childFor, logger } from '../utils/logger.js';
import { RATE_LIMIT_MAX_EVENTS, TRUST_FORWARDED_HEADERS } from '../config/index.js';

export interface HandlerDeps {
  io: Server;
  flights: FlightManager;
  users: UserManager;
  stats: StatManager;
}

/** Cost accounting: cheap reads are free, state changes and network relays are not. */
const COST = {
  create: 20,
  join: 20,
  leave: 5,
  signal: 2,
  ice: 1,
  invite: 10,
  nearby: 3,
  stats: 1,
} as const;

export function registerSocketHandlers(io: Server, deps: HandlerDeps): void {
  const { flights, users, stats } = deps;

  /** Pushes authoritative member state to everyone in a flight's room. */
  function broadcastUsers(code: string): void {
    const flight = flights.getFlight(code);
    // The old code returned silently here, which is precisely why a peer whose
    // owner disconnected sat on "waiting for someone to join" forever.
    if (!flight) {
      logger.debug({ code }, 'broadcastUsers for unknown flight — emitting flightDeleted');
      io.to(code).emit(EV.flightDeleted, 'owner-left');
      return;
    }

    io.to(code).emit(EV.flightUsers, {
      code: flight.code,
      ownerId: flight.ownerId,
      members: flights.getMembers(flight.code),
      ownerConnected: flight.ownerConnected,
    });
  }

  function announceDeparture(code: string, reason: FlightDeletedReason): void {
    if (flights.hasFlight(code)) {
      broadcastUsers(code);
      return;
    }
    io.to(code).emit(EV.flightDeleted, reason);
  }

  io.on('connection', (socket: Socket) => {
    const log = childFor('socket', socket.id);
    const name = getRandomName();

    // -- identity ----------------------------------------------------------
    const rawAddress = resolveClientAddress(
      socket.handshake.headers as Record<string, string | string[] | undefined>,
      socket.handshake.address,
      TRUST_FORWARDED_HEADERS,
    );
    const addr = classifyAddress(rawAddress);

    users.add(socket.id, UserManager.fromAddress(socket.id, name, addr));
    socket.emit(EV.yourName, { id: socket.id, name });

    log.info(
      { scope: addr.scope, fingerprint: addr.fingerprint, prefix: addr.prefix },
      'client connected',
    );

    // -- flight creation ---------------------------------------------------
    onBounded(socket, EV.createFlight, COST.create, async (socketId, ack: (a: Ack) => void) => {
      // Re-joining instead of creating a second flight keeps a double-tap or
      // a retried frame from leaking an orphaned room.
      const existing = flights.flightsFor(socketId);
      if (existing.length > 0) {
        return ack(ackOk({ code: existing[0] }));
      }

      const code = generateUniqueCode((c) => flights.hasFlight(c));
      flights.createFlight(code, socketId);
      stats.incFlights();

      // `join` is async in Socket.IO v4. Broadcasting before it resolves
      // races the room membership and the client never sees flightUsers.
      await socket.join(code);
      ack(ackOk({ code }));
      broadcastUsers(code);
    });

    // -- flight joining ----------------------------------------------------
    onBounded(
      socket,
      EV.joinFlight,
      COST.join,
      async (socketId, rawCode: unknown, ack: (a: Ack) => void) => {
        const parsed = JoinFlightClientSchema.safeParse([rawCode]);
        if (!parsed.success) {
          return ack(ackErr('BAD_CODE', 'That flight code is not valid'));
        }
        const [code] = parsed.data;

        const result = flights.joinFlight(code, socketId);
        if (!result.success) {
          return ack(ackErr(result.code, result.message));
        }

        await socket.join(result.code);

        // Tell the joiner who the other side is, if anyone. Without this the
        // joiner had no idea a peer existed until an offer happened to arrive.
        const peerId = flights.getPeer(result.code, socketId);
        if (peerId && !result.alreadyMember) {
          const peer = users.get(peerId);
          socket.emit(EV.flightStarted, {
            code: result.code,
            members: flights.getMembers(result.code),
          });
          log.debug({ peer: peer?.fingerprint ?? peerId }, 'joined flight with existing peer');
        }

        ack(ackOk({ code: result.code, members: flights.getMembers(result.code) }));

        // Broadcast AFTER the ack so the joiner has its state before it starts
        // processing the member list.
        broadcastUsers(result.code);
      },
    );

    // -- leaving -----------------------------------------------------------
    const handleLeave = (socketId: string) => {
      const affected = flights.leaveFlight(socketId);
      for (const { code, reason } of affected) {
        announceDeparture(code, reason);
      }
      if (affected.length > 0) {
        log.debug({ flights: affected.map((a) => a.code) }, 'left flight');
      }
    };

    onBounded(socket, EV.leaveFlight, COST.leave, handleLeave);
    onBounded(socket, 'leaveAllFlights', COST.leave, handleLeave);

    // -- signaling ---------------------------------------------------------
    // The previous handler was `(code, { sdp }) => ...`. Destructuring a missing
    // second argument is an instant TypeError, and an uncaught TypeError in a
    // Socket.IO listener terminates the process. One stale tab could restart
    // the service for everyone.
    onBounded(socket, EV.offer, COST.signal, (socketId, rawCode: unknown, rawSdp: unknown) => {
      const code = FlightCodeSchema.safeParse(rawCode);
      const sdp = SdpSchema.safeParse(rawSdp);
      if (!code.success || !sdp.success) return;

      if (!flights.isMember(code.data, socketId)) return;
      if (!flights.setSdp(code.data, socketId, sdp.data)) return;

      const peerId = flights.getPeer(code.data, socketId);
      if (!peerId) {
        // Nothing to negotiate with yet. Not an error — the owner offers
        // before anyone joins and the offer is replayed on join.
        log.debug({ code: code.data }, 'offer stored, no peer yet');
        return;
      }
      io.to(peerId).emit(EV.offer, socketId, sdp.data);
    });

    onBounded(socket, EV.answer, COST.signal, (socketId, rawCode: unknown, rawSdp: unknown) => {
      const code = FlightCodeSchema.safeParse(rawCode);
      const sdp = SdpSchema.safeParse(rawSdp);
      if (!code.success || !sdp.success) return;

      if (!flights.isMember(code.data, socketId)) return;
      flights.setSdp(code.data, socketId, sdp.data);

      const peerId = flights.getPeer(code.data, socketId);
      if (!peerId) return;
      io.to(peerId).emit(EV.answer, { id: socketId, sdp: sdp.data });
    });

    /**
     * ICE candidates are volume-heavy by nature — a typical connection emits
     * dozens. They get the cheapest validation and a relay counter so a
     * client cannot flood the server with millions of tiny frames.
     */
    onBounded(socket, EV.iceCandidate, COST.ice, (socketId, raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const payload = raw as { id?: unknown; candidate?: unknown };

      const targetId = SocketIdSchema.safeParse(payload.id);
      const candidate = IceCandidateSchema.safeParse(payload.candidate);
      if (!targetId.success || !candidate.success) return;

      // Membership is proven by sharing a flight with the target. A client
      // must not be able to inject ICE into an arbitrary peer's connection.
      const sharesFlight = flights
        .flightsFor(socketId)
        .some((code) => flights.getPeer(code, socketId) === targetId.data);
      if (!sharesFlight) return;

      io.to(targetId.data).emit(EV.iceCandidate, { id: socketId, candidate: candidate.data });
    });

    // -- invitations -------------------------------------------------------
    onBounded(
      socket,
      EV.inviteToFlight,
      COST.invite,
      async (socketId, raw: unknown, ack: (a: Ack) => void) => {
        const parsed = InviteClientSchema.safeParse([raw]);
        if (!parsed.success) return ack(ackErr('BAD_PAYLOAD', 'Invalid invite'));

        // NOTE: InviteClientSchema is a tuple, so this destructures element 0.
        const [{ targetId, flightCode }] = parsed.data;

        if (targetId === socketId) return ack(ackErr('SELF', 'You cannot invite yourself'));
        if (!flights.isMember(flightCode, socketId)) {
          return ack(ackErr('NOT_FOUND', 'Flight not found or you are not in it'));
        }

        // The old handler emitted to `targetId` unconditionally. Socket.IO
        // silently no-ops for an unknown id, so the inviter was told
        // "success" while nothing had happened at all.
        if (!users.get(targetId)) return ack(ackErr('OFFLINE', 'That device is no longer online'));

        const flight = flights.getFlight(flightCode)!;
        if (
          flight.members.length >= LIMITS.MAX_FLIGHT_MEMBERS &&
          !flight.members.includes(targetId)
        ) {
          return ack(ackErr('FULL', 'That flight already has both devices'));
        }

        const inviter = users.get(socketId);
        io.to(targetId).emit(EV.invitedToFlight, {
          flightCode,
          fromId: socketId,
          fromName: inviter?.name ?? 'Someone',
        });
        ack(ackOk());
      },
    );

    /**
     * Direct connect: A asks the server to pull B into a fresh flight.
     *
     * Previously this emitted `flightStarted`, which NO client ever listened
     * for. The receiving side was joined to a socket.io room server-side but
     * had no idea it had happened — a feature that could not work.
     */
    onBounded(
      socket,
      EV.requestToConnect,
      COST.invite,
      async (socketId, targetId: unknown, ack: (a: Ack) => void) => {
        const target = SocketIdSchema.safeParse(targetId);
        if (!target.success) return ack(ackErr('BAD_PAYLOAD', 'Invalid device'));
        if (target.data === socketId) return ack(ackErr('SELF', 'You cannot connect to yourself'));
        if (!users.get(target.data))
          return ack(ackErr('OFFLINE', 'That device is no longer online'));

        const code = generateUniqueCode((c) => flights.hasFlight(c));
        flights.createFlight(code, socketId);

        const joined = flights.joinFlight(code, target.data);
        if (!joined.success) return ack(ackErr(joined.code, joined.message));

        stats.incFlights();

        await socket.join(code);
        await io.in(target.data).socketsJoin(code);

        const members = flights.getMembers(code);
        io.to(code).emit(EV.flightStarted, { code, members });
        log.info({ code }, 'direct connect established');
        ack(ackOk({ code, members }));
      },
    );

    // -- discovery ---------------------------------------------------------
    onBounded(socket, EV.getNearbyUsers, COST.nearby, (socketId) => {
      socket.emit(EV.nearbyUsers, users.nearby(socketId));
    });

    // -- stats -------------------------------------------------------------
    onBounded(socket, EV.updateStats, COST.stats, (_socketId, raw: unknown) => {
      const parsed = UpdateStatsClientSchema.safeParse([raw]);
      if (!parsed.success) return;
      const [payload] = parsed.data;
      stats.incTransfer(payload.filesShared ?? 0, payload.bytesTransferred ?? 0);
    });

    // -- teardown ----------------------------------------------------------
    // The single most important handler in the file. The old version called
    // `broadcastUsers` for every affected flight, which silently returned when
    // the flight had already been deleted — so the surviving peer was never
    // told and the UI hung forever.
    socket.on('disconnect', (reason) => {
      const affected = flights.removeSocket(socket.id);
      for (const { code, reason: why } of affected) {
        announceDeparture(code, why);
      }
      users.remove(socket.id);
      log.info({ reason, flights: affected.map((a) => a.code) }, 'client disconnected');
    });
  });

  logger.info(
    { maxEventsPerWindow: RATE_LIMIT_MAX_EVENTS },
    'socket handlers registered with validation, authorization and isolation',
  );
}

/** Re-exported so tests and the flight page can build member payloads. */
export function toMember(id: string, name: string): Member {
  return { id, name };
}
