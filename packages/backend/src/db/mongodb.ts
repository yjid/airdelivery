import mongoose from 'mongoose';
import { DB_URI } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Mongo connection management.
 *
 * The old version fired `connectDB()` without awaiting it and swallowed every
 * error. The server then reported healthy while the database was unreachable,
 * and the first write (feedback submission) hung for the full 10 s
 * `serverSelectionTimeoutMS` before failing. Feedback "randomly" 500ing was
 * almost entirely this.
 *
 * Now the connection state is observable (`isDbReady`), failures are logged
 * once rather than per-event, and the server can report itself not-ready.
 */

let connecting: Promise<void> | null = null;

export function isDbReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export function isDbConnecting(): boolean {
  return mongoose.connection.readyState === 2;
}

export function dbState(): 'disconnected' | 'connected' | 'connecting' | 'disconnecting' | 'unknown' {
  switch (mongoose.connection.readyState) {
    case 0:
      return 'disconnected';
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnecting';
    default:
      return 'unknown';
  }
}

export async function connectDB(): Promise<void> {
  if (!DB_URI) {
    logger.warn('no DB_URI set — running without analytics and feedback persistence');
    return;
  }

  if (isDbReady()) return;
  if (connecting) return connecting;

  mongoose.connection.on('connected', () => logger.info('mongodb connected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'mongodb connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('mongodb disconnected'));

  connecting = mongoose
    .connect(DB_URI, {
      autoIndex: false,
      serverSelectionTimeoutMS: 5_000,
      // Fail fast instead of buffering commands for 10s and timing out —
      // buffering was the source of the mystery hangs.
      bufferCommands: false,
      maxPoolSize: 10,
    })
    .then(() => undefined)
    .catch((err) => {
      logger.error({ err }, 'initial mongodb connection failed — continuing without a database');
    })
    .finally(() => {
      connecting = null;
    });

  return connecting;
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close(false).catch(() => undefined);
}

/**
 * Retries the connection in the background.
 *
 * Mongoose gives up after `serverSelectionTimeoutMS`. On a cold container start
 * where Mongo is still booting, without this the app would run permanently
 * without analytics and feedback would never recover.
 */
export function scheduleReconnect(intervalMs = 15_000): () => void {
  const timer = setInterval(() => {
    if (isDbReady() || !DB_URI) return;
    void connectDB();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}