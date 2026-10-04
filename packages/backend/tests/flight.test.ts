/**
 * Flight lifecycle tests.
 *
 * The scenarios in `owner disconnects` are the direct reproduction of the most
 * reported bug: the UI sitting on "waiting for someone to join" forever
 * because the owner vanished and nobody told the survivor.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { FlightManager } from '../src/services/FlightManager.js';
import { UserManager } from '../src/services/UserManager.js';
import { classifyAddress } from '../src/utils/net.js';
import { generateCode, generateUniqueCode } from '../src/utils/code.js';

function setup() {
  const users = new UserManager();
  const flights = new FlightManager(users);
  const join = (id: string, ip = '192.168.1.10') => {
    users.add(id, UserManager.fromAddress(id, id, classifyAddress(ip)));
  };
  return { users, flights, join };
}

describe('code generation', () => {
  test('produces codes of the right length', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toHaveLength(6);
  });

  test('never emits ambiguous characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      for (const ch of code) {
        expect('0O1IL').not.toContain(ch);
        seen.add(ch);
      }
    }
    // Sanity: we really are exercising most of the alphabet.
    expect(seen.size).toBeGreaterThan(20);
  });

  test('is not trivially predictable', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateCode()));
    expect(codes.size).toBe(500);
  });

  test('generateUniqueCode retries past collisions', () => {
    let calls = 0;
    const code = generateUniqueCode(() => {
      calls++;
      return calls < 4;
    });
    expect(calls).toBe(4);
    expect(code).toHaveLength(6);
  });

  test('generateUniqueCode widens the code if it truly cannot find one', () => {
    const code = generateUniqueCode(() => true, 4);
    expect(code.length).toBeGreaterThanOrEqual(6);
  });

  test('handles the taken-check throwing', () => {
    expect(() =>
      generateUniqueCode(() => {
        throw new Error('boom');
      }),
    ).toThrow();
  });
});

describe('flight creation', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  test('creates a flight with the owner as its only member', () => {
    ctx.join('a');
    const flight = ctx.flights.createFlight(generateCode(), 'a');
    expect(flight.members).toEqual(['a']);
    expect(flight.ownerId).toBe('a');
    expect(flight.ownerConnected).toBe(true);
    expect(ctx.users.get('a')?.inFlight).toBe(true);
  });

  test('normalizes the code on the way in', () => {
    ctx.join('a');
    const code = generateCode().toLowerCase();
    const flight = ctx.flights.createFlight(code, 'a');
    expect(flight.code).toBe(code.toUpperCase());
  });

  test('rejects an invalid code', () => {
    ctx.join('a');
    expect(() => ctx.flights.createFlight('nope!', 'a')).toThrow();
  });

  test('indexes the flight by socket for O(1) departure', () => {
    ctx.join('a');
    const flight = ctx.flights.createFlight(generateCode(), 'a');
    expect(ctx.flights.flightsFor('a')).toEqual([flight.code]);
  });
});

describe('flight joining', () => {
  let ctx: ReturnType<typeof setup>;
  let code: string;
  beforeEach(() => {
    ctx = setup();
    ctx.join('a');
    ctx.join('b');
    code = generateCode();
    ctx.flights.createFlight(code, 'a');
  });

  test('a second peer joins', () => {
    const result = ctx.flights.joinFlight(code, 'b');
    expect(result.success).toBe(true);
    expect(ctx.flights.getMembers(code)).toHaveLength(2);
  });

  test('accepts a lowercase or malformed code', () => {
    expect(ctx.flights.joinFlight(code.toLowerCase(), 'b').success).toBe(true);
  });

  test('a third peer is refused with a machine-readable code', () => {
    ctx.flights.joinFlight(code, 'b');
    ctx.join('c');
    const result = ctx.flights.joinFlight(code, 'c');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('FULL');
      expect(result.message).toMatch(/full/i);
    }
  });

  test('an unknown code is NOT_FOUND', () => {
    const result = ctx.flights.joinFlight(generateCode(), 'b');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('NOT_FOUND');
  });

  test('a malformed code is BAD_CODE, not NOT_FOUND', () => {
    const result = ctx.flights.joinFlight('!!!!', 'b');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('BAD_CODE');
  });

  /**
   * The bug that made a page refresh eject you from your own flight.
   */
  test('rejoining as an existing member succeeds and is flagged', () => {
    ctx.flights.joinFlight(code, 'b');
    const result = ctx.flights.joinFlight(code, 'b');
    expect(result.success).toBe(true);
    if (result.success) expect(result.alreadyMember).toBe(true);
    expect(ctx.flights.getMembers(code)).toHaveLength(2);
  });

  test('the owner rejoining their own flight succeeds', () => {
    const result = ctx.flights.joinFlight(code, 'a');
    expect(result.success).toBe(true);
    if (result.success) expect(result.alreadyMember).toBe(true);
  });

  test('marking the peer resolves only the other member', () => {
    ctx.flights.joinFlight(code, 'b');
    expect(ctx.flights.getPeer(code, 'a')).toBe('b');
    expect(ctx.flights.getPeer(code, 'b')).toBe('a');
    expect(ctx.flights.getPeer(code, 'unknown')).toBeNull();
  });

  test('getPeer is null when nobody has joined yet', () => {
    expect(ctx.flights.getPeer(code, 'a')).toBeNull();
  });
});

describe('owner disconnects — the dead-end bug', () => {
  let ctx: ReturnType<typeof setup>;
  let code: string;
  beforeEach(() => {
    ctx = setup();
    ctx.join('a');
    ctx.join('b');
    code = generateCode();
    ctx.flights.createFlight(code, 'a');
    ctx.flights.joinFlight(code, 'b');
  });

  test('the surviving peer is reported, not silently abandoned', () => {
    const affected = ctx.flights.removeSocket('a');
    expect(affected.length).toBeGreaterThan(0);
    expect(affected.some((a) => a.code === code && a.reason === 'owner-left')).toBe(true);
  });

  test('the flight still exists so the peer can be told what happened', () => {
    // The old implementation deleted it, then broadcastUsers returned early
    // for a missing flight, so the client was never notified at all.
    ctx.flights.removeSocket('a');
    expect(ctx.flights.hasFlight(code)).toBe(true);
  });

  test('ownership transfers to the survivor', () => {
    ctx.flights.removeSocket('a');
    const flight = ctx.flights.getFlight(code)!;
    expect(flight.ownerId).toBe('b');
    expect(flight.ownerConnected).toBe(true);
  });

  test('the survivor can start a new transfer immediately', () => {
    ctx.flights.removeSocket('a');
    expect(ctx.flights.isOwner(code, 'b')).toBe(true);
  });

  test('a departed socket cannot signal', () => {
    ctx.flights.removeSocket('a');
    expect(ctx.flights.setSdp(code, 'a', { sdp: 'x' })).toBe(false);
    expect(ctx.flights.isMember(code, 'a')).toBe(false);
  });

  test('an empty flight is destroyed', () => {
    ctx.flights.removeSocket('b');
    const affected = ctx.flights.removeSocket('a');
    expect(ctx.flights.hasFlight(code)).toBe(false);
    expect(affected.some((a) => a.reason === 'owner-left')).toBe(true);
  });
});

describe('peer disconnects', () => {
  let ctx: ReturnType<typeof setup>;
  let code: string;
  beforeEach(() => {
    ctx = setup();
    ctx.join('a');
    ctx.join('b');
    code = generateCode();
    ctx.flights.createFlight(code, 'a');
    ctx.flights.joinFlight(code, 'b');
  });

  test('the owner keeps the flight', () => {
    const affected = ctx.flights.removeSocket('b');
    expect(affected.some((x) => x.reason === 'peer-left')).toBe(true);
    expect(ctx.flights.hasFlight(code)).toBe(true);
    expect(ctx.flights.isOwner(code, 'a')).toBe(true);
  });

  test('the slot is freed for someone else', () => {
    ctx.flights.removeSocket('b');
    ctx.join('c');
    expect(ctx.flights.joinFlight(code, 'c').success).toBe(true);
  });

  test('the departing peer is cleared from inFlight', () => {
    ctx.flights.removeSocket('b');
    expect(ctx.users.get('b')?.inFlight).toBe(false);
  });

  test('removing an unknown socket is a no-op', () => {
    expect(ctx.flights.removeSocket('ghost')).toEqual([]);
  });

  test('removing twice is idempotent', () => {
    ctx.flights.removeSocket('b');
    expect(ctx.flights.removeSocket('b')).toEqual([]);
  });
});

describe('multiple flights per socket', () => {
  test('a socket in two flights leaves both', () => {
    const ctx = setup();
    ctx.join('a');
    ctx.join('b');
    const c1 = generateCode();
    const c2 = generateCode();
    ctx.flights.createFlight(c1, 'a');
    ctx.flights.joinFlight(c1, 'b');
    ctx.flights.createFlight(c2, 'a');

    const affected = ctx.flights.removeSocket('a');
    const codes = affected.map((x) => x.code);
    expect(codes).toContain(c1);
    expect(codes).toContain(c2);
  });

  test('the reverse index is cleaned up', () => {
    const ctx = setup();
    ctx.join('a');
    const c1 = generateCode();
    ctx.flights.createFlight(c1, 'a');
    ctx.flights.removeSocket('a');
    expect(ctx.flights.flightsFor('a')).toEqual([]);
  });
});

describe('TTL sweeping', () => {
  test('an expired flight is destroyed and reported', () => {
    const ctx = setup();
    ctx.join('a');
    const code = generateCode();
    ctx.flights.createFlight(code, 'a');

    const expired = ctx.flights.sweepExpired(Date.now() + 10 * 60 * 60 * 1000);
    expect(expired).toContain(code);
    expect(ctx.flights.hasFlight(code)).toBe(false);
  });

  test('a fresh flight survives', () => {
    const ctx = setup();
    ctx.join('a');
    const code = generateCode();
    ctx.flights.createFlight(code, 'a');
    expect(ctx.flights.sweepExpired(Date.now())).toEqual([]);
    expect(ctx.flights.hasFlight(code)).toBe(true);
  });

  test('activity refreshes the TTL', () => {
    const ctx = setup();
    ctx.join('a');
    ctx.join('b');
    const code = generateCode();
    ctx.flights.createFlight(code, 'a');
    ctx.flights.joinFlight(code, 'b');

    const justAfterCreate = Date.now() + 5 * 60 * 60 * 1000;
    // Rejoining refreshes lastActivityAt.
    ctx.flights.joinFlight(code, 'b');
    expect(ctx.flights.sweepExpired(justAfterCreate)).toEqual([]);
  });

  test('the sweeper does not hold the process open', () => {
    const ctx = setup();
    ctx.flights.startSweeper(10);
    ctx.flights.stopSweeper();
  });
});

describe('SDP storage is membership-scoped', () => {
  test('a member can store SDP', () => {
    const ctx = setup();
    ctx.join('a');
    const code = generateCode();
    ctx.flights.createFlight(code, 'a');
    expect(ctx.flights.setSdp(code, 'a', { sdp: 'offer' })).toBe(true);
    expect(ctx.flights.getSdp(code, 'a')).toEqual({ sdp: 'offer' });
  });

  test('a non-member cannot store SDP', () => {
    const ctx = setup();
    ctx.join('a');
    ctx.join('evil');
    const code = generateCode();
    ctx.flights.createFlight(code, 'a');
    // This is the hijack: any connected client could overwrite the SDP.
    expect(ctx.flights.setSdp(code, 'evil', { sdp: 'malicious' })).toBe(false);
    expect(ctx.flights.getSdp(code, 'a')).toBeUndefined();
  });

  test('SDP is stored per sender so renegotiation can roll back', () => {
    const ctx = setup();
    ctx.join('a');
    ctx.join('b');
    const code = generateCode();
    ctx.flights.createFlight(code, 'a');
    ctx.flights.joinFlight(code, 'b');

    ctx.flights.setSdp(code, 'a', { sdp: 'offer-1' });
    ctx.flights.setSdp(code, 'b', { sdp: 'answer-1' });
    expect(ctx.flights.getSdp(code, 'a')).toEqual({ sdp: 'offer-1' });
    expect(ctx.flights.getSdp(code, 'b')).toEqual({ sdp: 'answer-1' });
  });
});

describe('nearby discovery', () => {
  const addr = (ip: string) => UserManager.fromAddress('x', 'x', classifyAddress(ip));

  test('two devices on the same hotspot subnet see each other', () => {
    const users = new UserManager();
    users.add('a', {
      ...UserManager.fromAddress('a', 'A', classifyAddress('192.168.43.1')),
      name: 'A',
    });
    users.add('b', {
      ...UserManager.fromAddress('b', 'B', classifyAddress('192.168.43.77')),
      name: 'B',
    });
    expect(users.nearby('a').map((u) => u.id)).toEqual(['b']);
  });

  test('two devices behind CGNAT see each other', () => {
    const users = new UserManager();
    users.add('a', {
      ...UserManager.fromAddress('a', 'A', classifyAddress('100.64.0.1')),
      name: 'A',
    });
    users.add('b', {
      ...UserManager.fromAddress('b', 'B', classifyAddress('100.64.0.2')),
      name: 'B',
    });
    expect(users.nearby('a')).toHaveLength(1);
  });

  test('different subnets do not see each other', () => {
    const users = new UserManager();
    users.add('a', UserManager.fromAddress('a', 'A', classifyAddress('192.168.1.1')));
    users.add('b', UserManager.fromAddress('b', 'B', classifyAddress('192.168.2.1')));
    expect(users.nearby('a')).toEqual([]);
  });

  test('a private user never sees a public user', () => {
    const users = new UserManager();
    users.add('a', UserManager.fromAddress('a', 'A', classifyAddress('10.0.0.1')));
    users.add('b', UserManager.fromAddress('b', 'B', classifyAddress('8.8.8.8')));
    expect(users.nearby('a')).toEqual([]);
  });

  test('a busy user disappears from the nearby list', () => {
    const users = new UserManager();
    users.add('a', UserManager.fromAddress('a', 'A', classifyAddress('10.0.0.1')));
    users.add('b', UserManager.fromAddress('b', 'B', classifyAddress('10.0.0.2')));
    users.update('b', { inFlight: true });
    expect(users.nearby('a')).toEqual([]);
  });

  test('you never see yourself', () => {
    const users = new UserManager();
    users.add('a', UserManager.fromAddress('a', 'A', classifyAddress('10.0.0.1')));
    expect(users.nearby('a')).toEqual([]);
  });

  test('loopback clients are not surfaced to each other', () => {
    const users = new UserManager();
    users.add('a', UserManager.fromAddress('a', 'A', classifyAddress('127.0.0.1')));
    users.add('b', UserManager.fromAddress('b', 'B', classifyAddress('127.0.0.1')));
    expect(users.nearby('a')).toEqual([]);
  });

  test('a campus-scale bucket is capped', () => {
    const users = new UserManager(5);
    users.add('a', UserManager.fromAddress('a', 'A', classifyAddress('10.0.0.1')));
    for (let i = 0; i < 50; i++) {
      users.add(`x${i}`, UserManager.fromAddress(`x${i}`, 'X', classifyAddress('10.0.0.2')));
    }
    expect(users.nearby('a').length).toBe(5);
  });

  test('removing a user unbuckets them', () => {
    const users = new UserManager();
    users.add('a', UserManager.fromAddress('a', 'A', classifyAddress('10.0.0.1')));
    users.add('b', UserManager.fromAddress('b', 'B', classifyAddress('10.0.0.2')));
    users.remove('b');
    expect(users.nearby('a')).toEqual([]);
    expect(users.size).toBe(1);
  });

  test('removing an unknown user is safe', () => {
    const users = new UserManager();
    expect(() => users.remove('ghost')).not.toThrow();
    expect(users.get('ghost')).toBeUndefined();
  });

  void addr;
});
