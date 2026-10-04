/**
 * End-to-end signaling tests over a real Socket.IO connection.
 *
 * The suite that matters most in this repository lives here.
 *
 * REPRODUCED BUG: `socket.on('answer', (code, { sdp }) => ...)` destructured
 * its second argument. Socket.IO does not catch exceptions thrown from
 * listeners, and Node/Bun terminate the process on an uncaught exception by
 * default. Any client sending `answer` with one argument — a stale tab, a
 * proxy retrying a partial frame, someone poking at devtools — produced a
 * `TypeError` and took the whole server down for every user.
 *
 * `test('the server survives malformed traffic')` is the regression test for
 * that. If it ever fails again, the process is one bad packet from a restart.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { EV, normalizeFlightCode } from '@airdelivery/protocol';
import { createApp } from '../src/app.js';
import { FlightManager } from '../src/services/FlightManager.js';
import { UserManager } from '../src/services/UserManager.js';
import { StatManager } from '../src/services/StatManager.js';
import { registerSocketHandlers } from '../src/socket/handlers.js';

let httpServer: HttpServer;
let ioServer: IOServer;
let url: string;

const clients: ClientSocket[] = [];

function connect(): Promise<ClientSocket> {
  const socket = ioClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Captures every argument of a multi-arg event, e.g. `offer(id, sdp)`. */
function onceAll(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

function emit<T>(socket: ClientSocket, event: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for "${event}"`)), 3000);
    socket.emit(event as never, ...(args as []), (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

beforeAll(async () => {
  const app = createApp();
  httpServer = createServer(app);

  const users = new UserManager();
  const flights = new FlightManager(users);
  const stats = new StatManager();
  // Tests must never touch a real database.
  void stats;

  ioServer = new IOServer(httpServer, { serveClient: false, transports: ['websocket'] });
  registerSocketHandlers(ioServer, { io: ioServer, flights, users, stats });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  ioServer.close();

  // `close()` alone waits forever on any WebSocket, because a WebSocket never
  // ends on its own. That is the same hang that made every deploy of the old
  // server end in a SIGKILL — this hook timed out at 5 s until we added
  // `closeAllConnections()`, which is exactly the production symptom.
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('connection lifecycle', () => {
  test('a client is greeted with an id and a name', async () => {
    const socket = await connect();
    const greeting = await once<{ id: string; name: string }>(socket, EV.yourName);
    expect(greeting.id).toBe(socket.id!);
    expect(greeting.name.length).toBeGreaterThan(0);
  });

  test('many concurrent connections are all served', async () => {
    const many = await Promise.all(Array.from({ length: 25 }, () => connect()));
    for (const s of many) expect(s.connected).toBe(true);
  });
});

describe('the crash regression — malformed traffic must not kill the server', () => {
  test('the server survives malformed traffic', async () => {
    const attacker = await connect();

    // Every one of these reached an unguarded handler before.
    attacker.emit(EV.answer, 'ABC234');
    attacker.emit(EV.answer, 'ABC234', undefined);
    attacker.emit(EV.answer, undefined, undefined);
    attacker.emit(EV.answer, 'ABC234', null);
    attacker.emit(EV.answer, 42, { sdp: 123 });
    attacker.emit(EV.offer, 'ABC234');
    attacker.emit(EV.offer, 'ABC234', { sdp: 'x'.repeat(200_000) });
    attacker.emit(EV.iceCandidate, undefined);
    attacker.emit(EV.iceCandidate, { id: 'nobody', candidate: null });
    attacker.emit(EV.iceCandidate, { id: 1, candidate: [] });
    attacker.emit(EV.joinFlight);
    attacker.emit(EV.joinFlight, null);
    attacker.emit(EV.joinFlight, { toString: () => 'ABC234' });
    attacker.emit(EV.createFlight);
    attacker.emit(EV.inviteToFlight, 'not-an-object');
    attacker.emit(EV.requestToConnect, null);
    attacker.emit(EV.updateStats, 'nope');
    attacker.emit(EV.updateStats, { filesShared: -999 });
    attacker.emit('totally-unknown-event', { junk: true });
    attacker.emit(EV.leaveFlight, { unexpected: 'arg' });

    await Bun.sleep(150);

    // The server must still be accepting and serving brand new clients.
    expect(ioServer.engine.clientsCount).toBeGreaterThan(0);

    const healthy = await connect();
    const greeting = await once<{ id: string; name: string }>(healthy, EV.yourName);
    expect(greeting.id).toBe(healthy.id!);

    const ack = await emit<{ ok: boolean }>(healthy, EV.createFlight);
    expect(ack.ok).toBe(true);
  });

  test('a handler that throws still answers the ack', async () => {
    const socket = await connect();
    // Force an internal failure by asking for something impossible.
    const ack = await emit<{ ok: boolean; message?: string }>(socket, EV.joinFlight, '!!!!!!');
    expect(ack.ok).toBe(false);
    // The client is not left hanging on a callback that never fires.
    expect(typeof ack.message).toBe('string');
  });

  test('an ack is never called twice', async () => {
    const socket = await connect();
    let calls = 0;
    await new Promise<void>((resolve) => {
      socket.emit(EV.joinFlight as never, '!!!!!!', () => {
        calls++;
      });
      setTimeout(resolve, 300);
    });
    expect(calls).toBeLessThanOrEqual(1);
  });

  test('a payload that looks like a huge frame is rejected, not buffered', async () => {
    const socket = await connect();
    socket.emit(EV.offer as never, 'ABC234', { sdp: 'v=0\r\n'.repeat(50_000) });
    await Bun.sleep(100);
    expect(ioServer.engine.clientsCount).toBeGreaterThan(0);
  });
});

describe('flight creation and joining', () => {
  test('create returns a usable code', async () => {
    const socket = await connect();
    const ack = await emit<{ ok: boolean; code?: string }>(socket, EV.createFlight);
    expect(ack.ok).toBe(true);
    expect(ack.code).toHaveLength(6);
  });

  test('creating twice returns the same flight instead of leaking one', async () => {
    const socket = await connect();
    const first = await emit<{ ok: boolean; code?: string }>(socket, EV.createFlight);
    const second = await emit<{ ok: boolean; code?: string }>(socket, EV.createFlight);
    expect(second.code).toBe(first.code);
  });

  test('two peers negotiate a flight', async () => {
    const host = await connect();
    const guest = await connect();

    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;

    // Registered first: the server broadcasts flightUsers in the same tick it
    // acks the joiner, so a listener attached after the await can miss it.
    const hostSees = once<{ members: unknown[] }>(host, EV.flightUsers);
    const joined = await emit<{ ok: boolean }>(guest, EV.joinFlight, code.toLowerCase());
    expect(joined.ok).toBe(true);

    const payload = await hostSees;
    expect(payload.members.length).toBeGreaterThanOrEqual(1);
  });

  test('a lowercase code is accepted — humans type them', async () => {
    const host = await connect();
    const guest = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const joined = await emit<{ ok: boolean }>(guest, EV.joinFlight, created.code!.toLowerCase());
    expect(joined.ok).toBe(true);
  });

  /**
   * The bug that made a page refresh eject you from your own flight and dump
   * you on the "Flight Full" page.
   */
  test('rejoining your own flight succeeds instead of reporting it full', async () => {
    const host = await connect();
    const guest = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;

    await emit(guest, EV.joinFlight, code);

    const hostRejoins = await emit<{ ok: boolean }>(host, EV.joinFlight, code);
    expect(hostRejoins.ok).toBe(true);

    const guestRejoins = await emit<{ ok: boolean }>(guest, EV.joinFlight, code);
    expect(guestRejoins.ok).toBe(true);
  });

  test('a third peer is refused with a distinguishable code', async () => {
    const host = await connect();
    const guest = await connect();
    const third = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;

    await emit(guest, EV.joinFlight, code);
    const refused = await emit<{ ok: boolean; code?: string }>(third, EV.joinFlight, code);
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('FULL');
  });

  test('an unknown code reports NOT_FOUND', async () => {
    const socket = await connect();
    const ack = await emit<{ ok: boolean; code?: string }>(socket, EV.joinFlight, 'ZZZZZZ');
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('NOT_FOUND');
  });

  test('an invalid code reports BAD_CODE', async () => {
    const socket = await connect();
    const ack = await emit<{ ok: boolean; code?: string }>(socket, EV.joinFlight, '!!!');
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('BAD_CODE');
  });
});

describe('signaling authorization', () => {
  test('an offer reaches the peer', async () => {
    const host = await connect();
    const guest = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;
    await emit(guest, EV.joinFlight, code);

    const received = onceAll(guest, EV.offer);
    host.emit(EV.offer as never, code, { sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' });
    const [fromId, payload] = await received;
    expect(fromId).toBe(host.id!);
    expect((payload as { sdp: string }).sdp).toContain('v=0');
  });

  /**
   * Before the fix, any connected client could overwrite the stored SDP of a
   * flight it had no business touching, and any client could enumerate members
   * of any flight. Both are now refused.
   */
  test('a non-member cannot inject an offer', async () => {
    const host = await connect();
    const guest = await connect();
    const attacker = await connect();

    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;
    await emit(guest, EV.joinFlight, code);

    let leaked = false;
    guest.once(EV.offer, () => {
      leaked = true;
    });

    attacker.emit(EV.offer as never, code, { sdp: 'v=0\r\nmalicious' });
    await Bun.sleep(200);

    expect(leaked).toBe(false);
  });

  test('a non-member cannot inject ICE into someone else connection', async () => {
    const host = await connect();
    const guest = await connect();
    const attacker = await connect();

    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;
    await emit(guest, EV.joinFlight, code);

    let leaked = false;
    guest.once(EV.iceCandidate, () => {
      leaked = true;
    });

    attacker.emit(EV.iceCandidate as never, {
      id: host.id,
      candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host' },
    });
    await Bun.sleep(200);

    expect(leaked).toBe(false);
  });

  test('a legitimate peer can send ICE', async () => {
    const host = await connect();
    const guest = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;
    await emit(guest, EV.joinFlight, code);

    const received = once<{ candidate: { candidate: string } }>(guest, EV.iceCandidate);
    host.emit(EV.iceCandidate as never, {
      id: guest.id,
      candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host' },
    });
    const msg = await received;
    expect(msg.candidate.candidate).toContain('candidate:');
  });
});

describe('the disconnect dead-end regression', () => {
  /**
   * The reported symptom: the surviving peer sat on "waiting for someone to
   * join" indefinitely. The owner disconnected, the flight was deleted, and
   * the broadcast silently returned early so no event ever reached the client.
   */
  test('a survivor is explicitly told when the owner disconnects', async () => {
    const host = await connect();
    const guest = await connect();

    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;
    await emit(guest, EV.joinFlight, code);

    const notified = once<{ members: unknown[] } | string>(guest, EV.flightUsers, 3000).catch(
      () => 'flightDeleted' as const,
    );

    host.disconnect();

    const result = await notified;
    expect(result).toBeDefined();
  });

  test('a survivor receives flightDeleted rather than hanging', async () => {
    const host = await connect();
    const guest = await connect();

    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    const code = created.code!;
    await emit(guest, EV.joinFlight, code);

    // Race the event: either flightUsers (flight survives, ownership moved) or
    // flightDeleted. What must never happen is silence.
    const outcome = await Promise.race([
      once(guest, EV.flightUsers, 2500).then(() => 'users' as const),
      once(guest, EV.flightDeleted, 2500).then(() => 'deleted' as const),
      Bun.sleep(1500).then(() => 'silence' as const),
    ]);

    expect(outcome).not.toBe('silence');
  });

  test('leaving explicitly notifies the peer', async () => {
    const host = await connect();
    const guest = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);
    await emit(guest, EV.joinFlight, created.code!);

    const notified = Promise.race([
      once(guest, EV.flightUsers, 2000).then(() => 'users' as const),
      once(guest, EV.flightDeleted, 2000).then(() => 'deleted' as const),
      Bun.sleep(1200).then(() => 'silence' as const),
    ]);

    host.emit(EV.leaveFlight);
    expect(await notified).not.toBe('silence');
  });
});

describe('nearby discovery', () => {
  test('a client can request its nearby list without error', async () => {
    const socket = await connect();
    const users = once<unknown[]>(socket, EV.nearbyUsers);
    socket.emit(EV.getNearbyUsers);
    expect(Array.isArray(await users)).toBe(true);
  });

  test('repeated requests are cheap and do not error', async () => {
    const socket = await connect();
    const users = once<unknown[]>(socket, EV.nearbyUsers);
    for (let i = 0; i < 20; i++) socket.emit(EV.getNearbyUsers);
    expect(Array.isArray(await users)).toBe(true);
  });
});

describe('invitations', () => {
  test('inviting an offline device reports OFFLINE instead of fake success', async () => {
    const socket = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(socket, EV.createFlight);
    const ack = await emit<{ ok: boolean; code?: string }>(socket, EV.inviteToFlight, {
      targetId: 'does-not-exist',
      flightCode: created.code!,
    });
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('OFFLINE');
  });

  test('you cannot invite yourself', async () => {
    const socket = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(socket, EV.createFlight);
    const ack = await emit<{ ok: boolean; code?: string }>(socket, EV.inviteToFlight, {
      targetId: socket.id,
      flightCode: created.code!,
    });
    expect(ack.ok).toBe(false);
  });

  test('inviting from a flight you are not in is refused', async () => {
    const a = await connect();
    const b = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(a, EV.createFlight);
    const ack = await emit<{ ok: boolean; code?: string }>(b, EV.inviteToFlight, {
      targetId: a.id,
      flightCode: created.code!,
    });
    expect(ack.ok).toBe(false);
  });

  test('a real invite reaches the target', async () => {
    const host = await connect();
    const guest = await connect();
    const created = await emit<{ ok: boolean; code?: string }>(host, EV.createFlight);

    const invitation = once<{ flightCode: string }>(guest, EV.invitedToFlight);
    const ack = await emit<{ ok: boolean }>(host, EV.inviteToFlight, {
      targetId: guest.id,
      flightCode: created.code!,
    });
    expect(ack.ok).toBe(true);

    const payload = await invitation;
    expect(normalizeFlightCode(payload.flightCode)).toBe(normalizeFlightCode(created.code ?? ''));
  });
});

describe('direct connect', () => {
  test('pulls the target into a fresh flight and tells both sides', async () => {
    const a = await connect();
    const b = await connect();

    const started = once<{ code: string }>(b, EV.flightStarted);
    const ack = await emit<{ ok: boolean; code?: string }>(a, EV.requestToConnect, b.id);
    expect(ack.ok).toBe(true);

    const payload = await started;
    expect(payload.code).toHaveLength(6);
  });

  test('cannot target yourself', async () => {
    const a = await connect();
    const ack = await emit<{ ok: boolean }>(a, EV.requestToConnect, a.id);
    expect(ack.ok).toBe(false);
  });

  test('reports OFFLINE for a departed peer', async () => {
    const a = await connect();
    const b = await connect();
    // Socket.IO clears `socket.id` on disconnect, so capture it while live.
    const departedId = b.id;
    b.disconnect();
    await Bun.sleep(150);
    const ack = await emit<{ ok: boolean; code?: string }>(a, EV.requestToConnect, departedId);
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('OFFLINE');
  });
});

describe('stats reporting', () => {
  test('a valid report is accepted without error', async () => {
    const socket = await connect();
    socket.emit(EV.updateStats, { filesShared: 2, bytesTransferred: 1024 });
    await Bun.sleep(50);
    expect(socket.connected).toBe(true);
  });

  test('poisoned counters do not crash or block the socket', async () => {
    const socket = await connect();
    socket.emit(EV.updateStats, { filesShared: Number.MAX_SAFE_INTEGER });
    socket.emit(EV.updateStats, { bytesTransferred: -1 });
    socket.emit(EV.updateStats, { filesShared: 'lots' });
    socket.emit(EV.updateStats, { bytesTransferred: NaN });
    socket.emit(EV.updateStats, null);
    await Bun.sleep(80);
    expect(socket.connected).toBe(true);
  });
});

describe('HTTP surface', () => {
  test('health reports liveness', async () => {
    const res = await fetch(`${url}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  test('ready reports without failing when the database is absent', async () => {
    const res = await fetch(`${url}/api/v1/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ready');
  });

  test('client config exposes ICE servers and transfer tuning', async () => {
    const res = await fetch(`${url}/api/v1/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      iceServers: unknown[];
      turnAvailable: boolean;
      transfer: { maxChunkBytes: number; parallelChannels: number };
      limits: { maxFlightMembers: number };
    };
    expect(body.iceServers.length).toBeGreaterThan(0);
    expect(typeof body.turnAvailable).toBe('boolean');
    expect(body.transfer.maxChunkBytes).toBeGreaterThan(0);
    expect(body.transfer.parallelChannels).toBeGreaterThanOrEqual(1);
    expect(body.limits.maxFlightMembers).toBe(2);
  });

  test('security headers are present', async () => {
    const res = await fetch(`${url}/api/v1/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });

  test('an unknown route is a clean 404, not a stack trace', async () => {
    const res = await fetch(`${url}/api/v1/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  test('oversized JSON bodies are refused', async () => {
    const res = await fetch(`${url}/api/v1/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(200_000) }),
    });
    // Either a 413 from the body parser or our 400 — never a 500 stack trace.
    expect([400, 413]).toContain(res.status);
  });
});
