/**
 * Server entrypoint.
 *
 * The crash story, in one file.
 *
 * The old version had no `uncaughtException` and no `unhandledRejection`
 * handler. In Node and Bun the default for both is to terminate the process.
 * Socket.IO does not catch exceptions thrown from listeners, so any throw in a
 * handler — including a `TypeError` from destructuring a missing argument — was
 * a full server restart. That is what "the backend crashes a lot" was.
 *
 * The old shutdown was also unbounded: `server.close()` waits for every open
 * socket, WebSocket connections never end on their own, and there was no
 * deadline. Any deploy that sent SIGTERM hung until the platform SIGKILLed the
 * process — which, on a rolling deploy, means a hard cut for every transfer in
 * flight.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { createApp } from './app.js';
import { FlightManager } from './services/FlightManager.js';
import { UserManager } from './services/UserManager.js';
import { StatManager } from './services/StatManager.js';
import { registerSocketHandlers } from './socket/handlers.js';
import { FatalError, installProcessGuards } from './socket/guard.js';
import { connectDB, disconnectDB, scheduleReconnect } from './db/mongodb.js';
import {
  CORS_ORIGIN,
  PORT,
  SHUTDOWN_TIMEOUT_MS,
  SOCKET_MAX_BUFFER_BYTES,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_PING_TIMEOUT_MS,
  SOCKET_TRANSPORTS,
} from './config/index.js';
import { logger } from './utils/logger.js';

// ---------------------------------------------------------------------------
// Process guards — installed before anything that can throw.
// ---------------------------------------------------------------------------

const counters = { uncaught: 0, rejections: 0 };
let shuttingDown = false;

installProcessGuards({
  onFatal: () => void shutdown('fatal-error'),
  logger,
  counters,
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const app = createApp();
const httpServer = createServer(app);

const users = new UserManager();
const flights = new FlightManager(users);
const stats = new StatManager();

const io = new IOServer(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  serveClient: false,
  maxHttpBufferSize: SOCKET_MAX_BUFFER_BYTES,
  pingInterval: SOCKET_PING_INTERVAL_MS,
  pingTimeout: SOCKET_PING_TIMEOUT_MS,
  connectionStateRecovery: {
    // A phone that drops off Wi-Fi for 30 seconds and comes back keeps its
    // socket id, and therefore its flight, instead of starting over.
    maxDisconnectionDuration: 2 * 60 * 1000,
  },
  perMessageDeflate: false,
  /**
   * Transport order matters enormously for reach.
   *
   * Forcing `['websocket']` only — as the client previously did — means any
   * network that strips or breaks the WebSocket upgrade (a large share of
   * corporate proxies and campus networks) cannot connect at all. The default
   * `['polling', 'websocket']` lets those clients establish a connection over
   * plain HTTP and then upgrade.
   */
  transports: SOCKET_TRANSPORTS,
  allowUpgrades: true,
});

registerSocketHandlers(io, { io, flights, users, stats });

flights.startSweeper();
stats.start();

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * A failure to bind is genuinely fatal: there is nothing to serve. Everything
 * else is contained.
 */
export class StartupError extends FatalError {}

async function start(): Promise<void> {
  // Deliberately not awaited. The signaling server does not depend on Mongo,
  // and a database outage must not stop file transfers from working.
  void connectDB();
  const stopReconnect = scheduleReconnect();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new StartupError(`port ${PORT} is already in use`));
      } else {
        reject(new StartupError(err.message));
      }
    };
    httpServer.once('error', onError);
    httpServer.listen(PORT, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  stopReconnect();
  logger.info(
    { port: PORT, transports: SOCKET_TRANSPORTS, cors: CORS_ORIGIN },
    'signaling server listening',
  );
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Bounded, ordered shutdown.
 *
 *   1. stop accepting new work
 *   2. tell clients why, so their UI can explain instead of hanging
 *   3. flush stats while the DB is still reachable
 *   4. force every socket closed at a hard deadline
 *   5. only then exit
 */
export async function shutdown(reason = 'signal'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason, uncaught: counters.uncaught, rejections: counters.rejections }, 'shutting down');

  const force = setTimeout(() => {
    logger.warn('shutdown deadline exceeded — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  try {
    // 1 + 2. Give every peer an explicit reason. Without this a deploy looks
    // exactly like a network failure to the other side.
    io.emit('flightDeleted', 'server-shutdown');
    io.disconnectSockets(true);

    // 3. Best effort, bounded.
    await Promise.race([stats.stop(), new Promise((r) => setTimeout(r, 2_000))]);

    flights.stopSweeper();

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Without this, `close` waits forever on any socket that never ends —
      // which is every WebSocket. This was the original hang.
      httpServer.closeAllConnections?.();
    });

    io.close();
    await disconnectDB();

    clearTimeout(force);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    clearTimeout(force);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

export { httpServer, io, flights, users, stats };