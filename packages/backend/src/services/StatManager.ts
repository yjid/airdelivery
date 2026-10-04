/**
 * Aggregate statistics.
 *
 * Two real bugs lived here.
 *
 * 1. The daily aggregation filter was
 *        { date: { $gte: new Date().setHours(0, 0, 0, 0) } }
 *    `setHours` returns a NUMBER. In MongoDB's BSON comparison order numbers
 *    sort before dates, so `$gte: <number>` matched EVERY document ever
 *    written — every flush incremented every day's counters. The fix is a real
 *    Date at local midnight.
 *
 * 2. The client sent a field named `Transferred` that held BYTES, persisted
 *    into a column called `totalMBTransferred`. Reported throughput was ~1000x
 *    too high. Units are now explicit end to end.
 *
 * On top of that: counters are clamped so one hostile client cannot poison
 * analytics, the buffer is restored on failure rather than silently dropped,
 * the timer is unref'd so it never holds the process open, and the whole thing
 * no-ops cleanly when Mongo is absent or disconnected.
 */

import { Stat } from '../model/stats.model.js';
import { isDbReady } from '../db/mongodb.js';
import { DB_URI, IS_TEST } from '../config/index.js';
import { logger } from '../utils/logger.js';

const MiB = 1024 * 1024;

export interface StatDelta {
  flights: number;
  files: number;
  bytes: number;
}

const EMPTY: Readonly<StatDelta> = { flights: 0, files: 0, bytes: 0 };

export class StatManager {
  private buffer: StatDelta = { ...EMPTY };
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly intervalMs = 30_000,
    /** Tests inject a clock; production uses the wall clock. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer || IS_TEST) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Total flights created. */
  incFlights(n = 1): void {
    this.buffer.flights += clamp(n, 0, 1_000_000);
  }

  /** `files` and `bytes` are raw client counters and get clamped hard. */
  incTransfer(files: number, bytes: number): void {
    this.buffer.files += clamp(files, 0, 100_000);
    this.buffer.bytes += clamp(bytes, 0, 1e15);
  }

  /** A snapshot copy, so callers cannot mutate internal counters. */
  get pending(): Readonly<StatDelta> {
    return { ...this.buffer };
  }

  /** Injected clock, exposed for assertions. */
  get clock(): () => Date {
    return this.now;
  }

  /**
   * Flushes the buffer.
   *
   * Serialized: overlapping flushes would double-count or race the buffer
   * swap. Returns the delta that was written, or null when there was nothing
   * to do / no database.
   */
  async flush(): Promise<StatDelta | null> {
    const run = async (): Promise<StatDelta | null> => {
      if (this.buffer.flights === 0 && this.buffer.files === 0 && this.buffer.bytes === 0) {
        return null;
      }

      if (!DB_URI) return null;
      if (!isDbReady()) {
        logger.warn('stats flush skipped: database not ready');
        return null;
      }

      const delta = this.buffer;
      this.buffer = { ...EMPTY };

      try {
        const midnight = new Date(this.now());
        midnight.setHours(0, 0, 0, 0);

        await Stat.updateOne(
          { date: midnight },
          {
            $inc: {
              totalFlights: delta.flights,
              totalFilesShared: delta.files,
              totalBytesTransferred: delta.bytes,
            },
            $setOnInsert: { date: midnight },
          },
          { upsert: true },
        ).exec();

        logger.debug({ ...delta, mib: +(delta.bytes / MiB).toFixed(2) }, 'stats flushed');
        return delta;
      } catch (error) {
        // Put it back so a transient Mongo blip does not lose counts. The
        // values are bounded, so this cannot grow without limit.
        this.buffer = {
          flights: this.buffer.flights + delta.flights,
          files: this.buffer.files + delta.files,
          bytes: this.buffer.bytes + delta.bytes,
        };
        logger.error({ err: error, delta }, 'stats flush failed, buffer restored');
        return null;
      }
    };

    // Chain onto the previous flush so overlapping calls serialize, and run
    // even if a prior one rejected.
    const next = this.flushing.then(run, run);
    this.flushing = next.catch(() => undefined);
    return next;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
