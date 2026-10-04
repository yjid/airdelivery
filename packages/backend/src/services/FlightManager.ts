/**
 * Flight (room) lifecycle.
 *
 * The old implementation had three defects that produced the single most
 * reported symptom — "it says waiting for someone to join forever":
 *
 *  1. When the owner disconnected, `leaveFlight` DELETED the flight. The
 *     `disconnect` handler then called `broadcastUsers`, which silently
 *     returned early for a missing flight. `flightDeleted` was only emitted
 *     from the `leaveFlight` event, never from `disconnect` — so the surviving
 *     peer was never told anything happened. Dead end, no error, no timeout.
 *
 *  2. `joinFlight` rejected with "Flight is full" whenever
 *     `members.length >= 2`, including for a member who was already in the
 *     flight. Refreshing `/flight/CODE` therefore bounced you to
 *     `/flightFull` on your own link.
 *
 *  3. `leaveFlight` scanned every flight on every disconnect: O(n) per event,
 *     O(n^2) overall. Under load this alone was enough to stall the event loop.
 *
 * This version keeps a socket -> flights index for O(1) lookups, makes joins
 * idempotent, never destroys state without notifying, and expires flights on a
 * TTL so a backgrounded mobile tab cannot squat a code forever.
 */

import { LIMITS, type FlightDeletedReason, type Member } from '@airdelivery/protocol';
import type { UserManager } from './UserManager.js';
import { normalizeFlightCode } from '../utils/code.js';
import { logger } from '../utils/logger.js';

export interface Flight {
  code: string;
  ownerId: string;
  /** Preserves join order. Never contains duplicates. */
  members: string[];
  ownerConnected: boolean;
  createdAt: number;
  lastActivityAt: number;
  /**
   * Latest offer, keyed by sender. Negotiation needs both directions to be
   * able to roll back; the old single `sdp` field could not represent that.
   */
  sdp: Map<string, unknown>;
}

/**
 * Machine-readable failure reasons.
 *
 * The client used to string-match on `'Flight is full'` to decide whether to
 * redirect. That is brittle; it now branches on `code`.
 */
export type JoinErrorCode = 'BAD_CODE' | 'NOT_FOUND' | 'FULL';

export interface JoinSuccess {
  success: true;
  code: string;
  /** True when the socket was already a member — the caller should not renegotiate. */
  alreadyMember: boolean;
  flight: Flight;
}

export interface JoinFailure {
  success: false;
  code: JoinErrorCode;
  message: string;
}

export type JoinResult = JoinSuccess | JoinFailure;

export class FlightManager {
  private flights = new Map<string, Flight>();
  /** O(1) reverse index: socket id -> the codes it belongs to. */
  private bySocket = new Map<string, Set<string>>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private userManager: UserManager,
    private readonly ttlMs: number = LIMITS.FLIGHT_TTL_MS,
    private readonly maxMembers: number = LIMITS.MAX_FLIGHT_MEMBERS,
  ) {}

  // -- lifecycle ------------------------------------------------------------

  startSweeper(intervalMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepExpired(), intervalMs);
    // Never hold the process open for housekeeping.
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Returns codes that expired, so the caller can notify their members. */
  sweepExpired(now = Date.now()): string[] {
    const expired: string[] = [];
    for (const [code, flight] of this.flights) {
      if (now - flight.lastActivityAt > this.ttlMs) {
        expired.push(code);
        this.destroy(code);
      }
    }
    if (expired.length > 0) {
      logger.warn({ count: expired.length, codes: expired.slice(0, 10) }, 'expired flights swept');
    }
    return expired;
  }

  // -- mutations ------------------------------------------------------------

  createFlight(code: string, ownerId: string): Flight {
    const normalized = normalizeFlightCode(code);
    if (!normalized) throw new Error(`invalid flight code: ${code}`);

    const now = Date.now();
    const flight: Flight = {
      code: normalized,
      ownerId,
      members: [ownerId],
      ownerConnected: true,
      createdAt: now,
      lastActivityAt: now,
      sdp: new Map(),
    };

    this.flights.set(normalized, flight);
    this.track(normalized, ownerId);
    this.userManager.update(ownerId, { inFlight: true });
    return flight;
  }

  joinFlight(rawCode: string, socketId: string): JoinResult {
    const code = normalizeFlightCode(rawCode);
    if (!code) return this.fail('BAD_CODE', 'That flight code is not valid');

    const flight = this.flights.get(code);
    if (!flight) return this.fail('NOT_FOUND', 'Flight not found');

    // Idempotent: rejoining a flight you are already in is a success, not a
    // "full" error. This is what stops a page refresh from ejecting you.
    if (flight.members.includes(socketId)) {
      flight.lastActivityAt = Date.now();
      return { success: true, code, alreadyMember: true, flight };
    }

    if (flight.members.length >= this.maxMembers) {
      return this.fail('FULL', 'Flight is full');
    }

    flight.members.push(socketId);
    flight.lastActivityAt = Date.now();
    this.track(code, socketId);
    this.userManager.update(socketId, { inFlight: true });
    return { success: true, code, alreadyMember: false, flight };
  }

  /**
   * A socket is going away — voluntarily or otherwise.
   *
   * Returns what happened per flight so the caller can tell the right story to
   * the remaining peers. A flight whose owner leaves is retained briefly so
   * the survivor gets an explicit `owner-left` event instead of silently
   * hanging; it is reclaimed by the TTL sweeper.
   *
   * `reasons` maps code -> reason so the caller can emit the right
   * `flightDeleted` payload.
   */
  removeSocket(socketId: string): Array<{ code: string; reason: FlightDeletedReason }> {
    const codes = this.bySocket.get(socketId);
    if (!codes || codes.size === 0) return [];

    const affected: Array<{ code: string; reason: FlightDeletedReason }> = [];

    for (const code of [...codes]) {
      const flight = this.flights.get(code);
      if (!flight) {
        codes.delete(code);
        continue;
      }

      const isOwner = flight.ownerId === socketId;
      flight.members = flight.members.filter((id) => id !== socketId);
      flight.lastActivityAt = Date.now();

      if (isOwner) {
        // Do NOT delete. Promote the survivor so the room keeps working, and
        // tell them explicitly. Deleting here is what caused the dead end.
        flight.ownerConnected = false;
        if (flight.members.length > 0) {
          flight.ownerId = flight.members[0];
          flight.ownerConnected = this.userManager.get(flight.ownerId) !== undefined;
        } else {
          this.destroy(code);
          affected.push({ code, reason: 'owner-left' });
        }
        affected.push({ code, reason: 'owner-left' });
      } else {
        affected.push({ code, reason: 'peer-left' });
        if (flight.members.length === 0) this.destroy(code);
      }
    }

    this.bySocket.delete(socketId);
    this.userManager.update(socketId, { inFlight: false });
    return affected;
  }

  /** Explicit, user-initiated leave. Same bookkeeping, different story. */
  leaveFlight(socketId: string): Array<{ code: string; reason: FlightDeletedReason }> {
    return this.removeSocket(socketId);
  }

  /** Hard removal, used by the sweeper and by shutdown. */
  destroy(code: string): boolean {
    const flight = this.flights.get(code);
    if (!flight) return false;
    this.flights.delete(code);
    for (const memberId of flight.members) {
      const set = this.bySocket.get(memberId);
      if (!set) continue;
      set.delete(code);
      if (set.size === 0) this.bySocket.delete(memberId);
      this.userManager.update(memberId, { inFlight: false });
    }
    return true;
  }

  // -- accessors ------------------------------------------------------------

  getFlight(code: string): Flight | undefined {
    const normalized = normalizeFlightCode(code);
    return normalized ? this.flights.get(normalized) : undefined;
  }

  hasFlight(code: string): boolean {
    return this.getFlight(code) !== undefined;
  }

  get size(): number {
    return this.flights.size;
  }

  /** True when the socket is a member of the flight. */
  isMember(code: string, socketId: string): boolean {
    return this.getFlight(code)?.members.includes(socketId) ?? false;
  }

  isOwner(code: string, socketId: string): boolean {
    return this.getFlight(code)?.ownerId === socketId;
  }

  /**
   * The other member, if the flight is full. This is the signaling target.
   *
   * Requires the requester to be a member: without that check, any connected
   * client could name any flight and learn a peer's socket id, which is the
   * first step of hijacking their connection.
   */
  getPeer(code: string, socketId: string): string | null {
    const flight = this.getFlight(code);
    if (!flight || !flight.members.includes(socketId)) return null;
    return flight.members.find((id) => id !== socketId) ?? null;
  }

  setSdp(code: string, socketId: string, sdp: unknown): boolean {
    const flight = this.getFlight(code);
    if (!flight || !flight.members.includes(socketId)) return false;
    flight.sdp.set(socketId, sdp);
    flight.lastActivityAt = Date.now();
    return true;
  }

  getSdp(code: string, socketId: string): unknown {
    return this.getFlight(code)?.sdp.get(socketId);
  }

  getMembers(code: string): Member[] {
    const flight = this.getFlight(code);
    if (!flight) return [];
    return flight.members.map((id) => ({
      id,
      name: this.userManager.get(id)?.name ?? `Peer-${id.slice(0, 4)}`,
    }));
  }

  /** Flight codes a socket currently belongs to. O(1). */
  flightsFor(socketId: string): string[] {
    const codes = this.bySocket.get(socketId);
    return codes ? [...codes] : [];
  }

  // -- internals ------------------------------------------------------------

  private track(code: string, socketId: string): void {
    let codes = this.bySocket.get(socketId);
    if (!codes) {
      codes = new Set();
      this.bySocket.set(socketId, codes);
    }
    codes.add(code);
  }

  private fail(code: JoinErrorCode, message: string): JoinFailure {
    return { success: false, code, message };
  }
}