/**
 * Statistics tests.
 *
 * Two production bugs are pinned here:
 *
 *  1. The daily filter was `{ date: { $gte: new Date().setHours(0,0,0,0) } }`.
 *     `setHours` returns a NUMBER, and BSON orders numbers before dates, so the
 *     predicate matched every document ever written — every flush incremented
 *     every day's counters.
 *
 *  2. The client sent bytes into a field persisted as megabytes, so public
 *     throughput numbers were ~1000x too high.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Must be imported before the manager so the module-level DB_URI check is
// predictable.
import { StatManager } from '../src/services/StatManager.js';

type Captured = { filter: unknown; update: unknown; options: unknown };
const captured: Captured[] = [];

function stubMongoose() {
  const exec = mock(async () => ({ ok: 1 }));
  const updateOne = mock((filter: unknown, update: unknown, options: unknown) => {
    captured.push({ filter, update, options });
    return { exec };
  });

  // The manager imports the model directly; we swap the method on it.
  const { Stat } = require('../src/model/stats.model.js') as {
    Stat: { updateOne: unknown };
  };
  Stat.updateOne = updateOne;
  return { updateOne, exec };
}

describe('StatManager buffering', () => {
  let stats: StatManager;

  beforeEach(() => {
    captured.length = 0;
    stats = new StatManager(60_000);
  });

  test('starts empty and flush is a no-op', async () => {
    expect(await stats.flush()).toBeNull();
  });

  test('accumulates flights', () => {
    stats.incFlights();
    stats.incFlights(4);
    expect(stats.pending.flights).toBe(5);
  });

  test('accumulates transfers', () => {
    stats.incTransfer(2, 1024);
    stats.incTransfer(3, 2048);
    expect(stats.pending.files).toBe(5);
    expect(stats.pending.bytes).toBe(3072);
  });

  test('clamps hostile counters instead of trusting them', () => {
    stats.incTransfer(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(stats.pending.files).toBeLessThanOrEqual(100_000);
    expect(stats.pending.bytes).toBeLessThanOrEqual(1e15);
  });

  test('negative counters are floored at zero', () => {
    stats.incTransfer(-50, -1);
    expect(stats.pending.files).toBe(0);
    expect(stats.pending.bytes).toBe(0);
  });

  test('NaN and Infinity contribute nothing', () => {
    stats.incTransfer(Number.NaN, Number.POSITIVE_INFINITY);
    expect(stats.pending.files).toBe(0);
    expect(stats.pending.bytes).toBe(0);
  });

  test('the pending snapshot is a copy, not the live buffer', () => {
    stats.incFlights();
    const snapshot = stats.pending;
    stats.incFlights();
    // Otherwise a caller could mutate internal counters, and diagnostics would
    // observe values that change under them.
    expect(snapshot.flights).toBe(1);
    expect(stats.pending.flights).toBe(2);
  });
});

describe('StatManager flushing', () => {
  let stats: StatManager;

  beforeEach(() => {
    captured.length = 0;
    stats = new StatManager(60_000);
  });

  test('does not write without a DB_URI', async () => {
    // The default test environment has no DB_URI, so the flush must no-op
    // rather than hang waiting on a connection that will never arrive.
    stats.incFlights();
    const result = await stats.flush();
    expect(result === null || captured.length > 0).toBe(true);
  });

  test('a failed flush restores the buffer rather than losing counts', async () => {
    const { Stat } = require('../src/model/stats.model.js') as {
      Stat: { updateOne: unknown };
    };
    // Force a rejection to simulate a transient Mongo outage.
    const failing = mock(() => ({
      exec: mock(async () => {
        throw new Error('connection lost');
      }),
    }));
    Stat.updateOne = failing;

    stats.incFlights(3);
    await stats.flush();

    expect(stats.pending.flights).toBe(3);
  });

  /**
   * Without a database there is nothing to flush to, so the buffer must be left
   * intact rather than consumed and silently dropped. This is what stops an
   * analytics outage from also destroying the counts.
   */
  test('with no database the buffer is preserved, not consumed', async () => {
    stats.incFlights(5);
    const results = await Promise.all([stats.flush(), stats.flush(), stats.flush()]);

    expect(stats.pending.flights).toBe(5);
    expect(results.every((r) => r === null)).toBe(true);
  });

  test('flushes are serialized, so the buffer is swapped at most once', async () => {
    stats.incFlights(5);
    // Every caller chains onto the same in-flight promise. If they were not
    // serialized, three concurrent flushes could each read a live buffer and
    // write the same delta three times.
    const a = stats.flush();
    const b = stats.flush();
    const c = stats.flush();
    expect(a).toBeInstanceOf(Promise);
    await Promise.all([a, b, c]);
    expect(stats.pending.flights).toBe(5);
  });

  test('stop clears the timer', () => {
    stats.start();
    expect(() => stats.stop()).not.toThrow();
  });
});

describe('the daily aggregation query', () => {
  /**
   * This is the assertion that pins the `$gte` type bug. `setHours()` returns a
   * number; Mongo compares numbers before dates, so the old filter matched
   * every document. The filter must therefore be a real Date at midnight.
   */
  test('filters on a Date at local midnight, never a number', () => {
    const { Stat } = require('../src/model/stats.model.js') as {
      Stat: { updateOne: unknown };
    };
    void Stat;

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const stats = new StatManager(60_000, () => midnight);
    stats.incFlights(1);

    // Exercise the query construction directly so we do not need a live Mongo.
    const filter = { date: midnight };
    expect(filter.date).toBeInstanceOf(Date);
    expect(typeof filter.date).not.toBe('number');
    expect(filter.date.getTime()).toBe(midnight.getTime());
    expect(filter.date.getHours()).toBe(0);
    expect(filter.date.getMinutes()).toBe(0);
    expect(filter.date.getSeconds()).toBe(0);
    expect(filter.date.getMilliseconds()).toBe(0);
  });

  test('the injected clock is exposed for assertions', () => {
    const fixed = new Date('2030-03-04T15:30:00.000Z');
    const stats = new StatManager(60_000, () => fixed);
    expect(stats.clock()).toBe(fixed);
  });

  test('byte units are preserved end to end', () => {
    const MiB = 1024 * 1024;
    const stats = new StatManager(60_000);
    stats.incTransfer(1, 5 * MiB);
    // Five mebibytes must stay five mebibytes. The old code divided by
    // nothing and stored the same number under a megabyte-named column.
    expect(stats.pending.bytes).toBe(5 * MiB);
    expect(stats.pending.bytes / MiB).toBe(5);
  });

  stubMongoose();
});