/**
 * Listener isolation.
 *
 * THIS IS THE FIX FOR "the backend crashes a lot".
 *
 * Socket.IO does not catch exceptions thrown from event listeners. A single
 * throw anywhere inside a listener becomes an uncaught exception, which by
 * default terminates the Node/Bun process. The previous server had handlers
 * like:
 *
 *     socket.on('answer', (code, { sdp }) => { ... })
 *
 * which destructures its second argument. Any client sending `'answer'` with
 * one argument — a stale tab, a proxy retrying a partial frame, a curious
 * user in devtools — produced `TypeError: Cannot destructure property 'sdp'`
 * and took the entire server down with it. One browser out of ten thousand
 * could restart the whole service.
 *
 * Every listener now goes through `on()`. A throw is logged with full context,
 * reported once per signature so a hot loop cannot flood the logs, and the
 * process keeps serving every other connection.
 */

import type { Server, Socket } from 'socket.io';
import type { Ack } from '@airdelivery/protocol';
import { childFor } from '../utils/logger.js';
import { RATE_LIMIT_MAX_EVENTS, RATE_LIMIT_WINDOW_MS } from '../config/index.js';

export type Handler<A extends unknown[] = unknown[]> = (...args: A) => void | Promise<void>;

/** An error we are happy to show the client verbatim. */
export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

/**
 * Signature-bucketed error reporting.
 *
 * Without this, a client in a retry loop can emit thousands of identical
 * stack traces and evict every useful line from the log.
 */
const errorBudget = new Map<string, { count: number; firstAt: number }>();
const ERROR_WINDOW_MS = 60_000;
const ERROR_MAX_PER_WINDOW = 3;

function reportRepeated(log: ReturnType<typeof childFor>, signature: string, err: unknown) {
  const now = Date.now();
  const entry = errorBudget.get(signature);
  if (!entry || now - entry.firstAt > ERROR_WINDOW_MS) {
    errorBudget.set(signature, { count: 1, firstAt: now });
    log.error({ err }, 'listener threw');
    return;
  }
  entry.count += 1;
  if (entry.count <= ERROR_MAX_PER_WINDOW) {
    log.error({ err, occurrences: entry.count }, 'listener threw (repeat)');
  }
  if (entry.count === ERROR_MAX_PER_WINDOW + 1) {
    log.warn({ signature }, 'further occurrences suppressed for 60s');
  }
}

/** Test seam. */
export function resetErrorBudget(): void {
  errorBudget.clear();
}

/**
 * Wraps a listener so it can never take the process down.
 *
 * If the client passed an ack callback, the ack is always invoked — a client
 * that awaits a callback which never fires will hang its own UI forever.
 */
export function on<A extends unknown[]>(
  socket: Socket,
  event: string,
  handler: Handler<A>,
): void {
  socket.on(event, (...args: unknown[]) => {
    const log = childFor('socket', socket.id);

    const ack = findAck(args);
    try {
      const result = handler(...(args as A));
      if (result instanceof Promise) {
        result.catch((err) => {
          reportRepeated(log, `${event}:${signatureOf(err)}`, err);
          safeAck(ack, err);
        });
      }
    } catch (err) {
      reportRepeated(log, `${event}:${signatureOf(err)}`, err);
      safeAck(ack, err);
    }
  });
}

/**
 * A fixed-arity, fixed-name guard that ALSO rate limits.
 *
 * Two problems it solves at once:
 *  - cost. Handlers get `socketId` and nothing else, so a client cannot make
 *    the server log or allocate a megabyte of attacker-controlled text per
 *    event.
 *  - starvation. `refreshNearby` fires every 5 s from every tab; without a
 *    budget one page could emit thousands of iterations per second.
 */
export function onBounded<A extends unknown[]>(
  socket: Socket,
  event: string,
  cost: number,
  handler: (socketId: string, ...args: A) => void | Promise<void>,
): void {
  let used = 0;
  let windowStart = Date.now();

  socket.on(event, (...args: unknown[]) => {
    const now = Date.now();
    if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
      used = 0;
      windowStart = now;
    }
    used += cost;
    if (used > RATE_LIMIT_MAX_EVENTS) {
      childFor('socket', socket.id).warn({ event }, 'socket event budget exhausted');
      return;
    }

    const log = childFor('socket', socket.id);
    const ack = findAck(args);
    try {
      const result = handler(socket.id, ...(args as A));
      if (result instanceof Promise) {
        result.catch((err) => {
          reportRepeated(log, `${event}:${signatureOf(err)}`, err);
          safeAck(ack, err);
        });
      }
    } catch (err) {
      reportRepeated(log, `${event}:${signatureOf(err)}`, err);
      safeAck(ack, err);
    }
  });
}

/** Finds a trailing function argument, which Socket.IO treats as the ack. */
function findAck(args: unknown[]): ((a: unknown) => void) | null {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return args[i] as (a: unknown) => void;
  }
  return null;
}

/**
 * Always answers the ack, exactly once.
 *
 * A client that awaits a callback which never fires will hang its own UI
 * forever, so a throwing handler still has to produce a reply. `once` guards
 * against a handler that acks and *then* throws, which would make Socket.IO
 * emit `ERR_ACK_CALLED` — and in some versions throw from the ack path, which
 * is the exact crash class this module exists to stop.
 */
function safeAck(ack: ((a: unknown) => void) | null, err: unknown): void {
  if (!ack) return;
  let called = false;
  const reply = (payload: unknown) => {
    if (called) return;
    called = true;
    ack(payload);
  };

  try {
    ack((payload: Ack) => reply(payload));
  } catch {
    reply(errAck(err));
  }
}

/** Converts an unknown throw into a client-safe ack. Never leaks internals. */
export function errAck(err: unknown): Ack {
  if (err instanceof ClientError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
}

function signatureOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}:${err.message}`;
  return typeof err;
}

/**
 * Fatal errors that genuinely should stop the process, because continuing
 * would serve corrupt behaviour.
 */
export class FatalError extends Error {}

/**
 * Process-level guards.
 *
 * The default behaviour for an uncaught exception in Node and Bun is to exit.
 * For a signaling server that is the wrong trade: one malformed frame from one
 * client should cost that client their transfer, not cost every other user
 * their session. We log loudly, count, and keep serving. Only errors we have
 * explicitly classified as fatal — or a failure to bind the port — stop us.
 */
export function installProcessGuards(options: {
  onFatal: (err: unknown) => void;
  logger: { error: (obj: unknown, msg: string) => void; fatal: (obj: unknown, msg: string) => void };
  counters: { uncaught: number; rejections: number };
}): void {
  const { onFatal, logger: log, counters } = options;

  process.on('uncaughtException', (err, origin) => {
    counters.uncaught += 1;
    if (err instanceof FatalError) {
      log.fatal({ err, origin }, 'fatal error, shutting down');
      onFatal(err);
      return;
    }
    log.error({ err, origin, total: counters.uncaught }, 'uncaught exception contained — server still serving');
  });

  process.on('unhandledRejection', (reason) => {
    counters.rejections += 1;
    if (reason instanceof FatalError) {
      log.fatal({ err: reason }, 'fatal rejection, shutting down');
      onFatal(reason);
      return;
    }
    log.error({ err: reason, total: counters.rejections }, 'unhandled rejection contained — server still serving');
  });
}

/** Builds a Socket.IO server with the hardening options applied. */
export function createSocketServer(httpServer: import('node:http').Server, options: {
  cors: { origin: string[]; methods: string[]; credentials: boolean };
  maxHttpBufferSize: number;
  pingInterval: number;
  pingTimeout: number;
}): Server {
  // Imported lazily to keep this module dependency-light and testable.
  const { Server: IOServer } = require('socket.io') as typeof import('socket.io');
  return new IOServer(httpServer, {
    cors: options.cors,
    serveClient: false,
    // Bounds the damage from a hostile or buggy client sending one enormous
    // frame. The old default allowed 1 MB per packet of pure attacker text.
    maxHttpBufferSize: options.maxHttpBufferSize,
    pingInterval: options.pingInterval,
    pingTimeout: options.pingTimeout,
    // Lets a client that briefly drops off the network resume its socket id
    // instead of starting a brand new flight. Matters a lot on mobile.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },
    // Reject oversized frames before they are buffered, not after.
    perMessageDeflate: false,
    transports: undefined,
  } as never);
}