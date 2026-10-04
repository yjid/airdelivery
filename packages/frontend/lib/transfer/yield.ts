/**
 * Cooperative yielding.
 *
 * The single most important performance bug in the old transfer loop was:
 *
 *     await new Promise((res) => setTimeout(res, 0));
 *
 * executed once per chunk. Browsers clamp nested `setTimeout(0)` to about 4 ms
 * after five levels of nesting, and the loop nests continuously, so the sender
 * was hard-capped at roughly 250 chunks per second. At a 64 KB chunk size that
 * is a ceiling of about 16 MB/s no matter how fast the link was — on a
 * gigabit LAN, on campus, on fibre. Users read this as "the site is slow".
 *
 * `MessageChannel` gives a genuine zero-delay yield: the port callback runs as
 * a task, not as a timer, so it is not clamped. `scheduler.yield()` is used
 * where available because it lets the browser prioritise other work more
 * intelligently than a plain task.
 */

type Yielder = () => Promise<void>;

let channel: MessageChannel | null = null;
const pending: Array<() => void> = [];

function getChannel(): MessageChannel | null {
  if (typeof MessageChannel === 'undefined') return null;
  if (channel) return channel;

  channel = new MessageChannel();
  channel.port1.onmessage = () => {
    // Drain everything queued, not just one callback: a burst of yields should
    // cost one task, not one task per waiter.
    const queued = pending.splice(0, pending.length);
    for (const resolve of queued) resolve();
  };
  // `port2` must be kept referenced or some engines will GC the channel.
  (channel as MessageChannel & { _keepAlive?: MessagePort })._keepAlive = channel.port2;
  return channel;
}

const messageChannelYield: Yielder = () =>
  new Promise<void>((resolve) => {
    const ch = getChannel();
    if (!ch) {
      // Last resort. Still better than nothing, but this is the slow path.
      setTimeout(resolve, 0);
      return;
    }
    pending.push(resolve);
    ch.port2.postMessage(0);
  });

const schedulerGlobal: Scheduler | undefined =
  typeof scheduler === 'undefined' ? undefined : scheduler;

const schedulerYield: Yielder | null =
  typeof schedulerGlobal?.yield === 'function' ? () => schedulerGlobal.yield!() : null;

const rafYield: Yielder = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });

/**
 * The default yielder.
 *
 * `scheduler.yield()` when available, otherwise a MessageChannel round trip.
 * Deliberately NOT `requestAnimationFrame`: it is throttled to the display
 * refresh rate and stalls entirely in a background tab, which would kill a
 * transfer the moment the user switched apps.
 */
export const yieldToEventLoop: Yielder = schedulerYield ?? messageChannelYield;

/**
 * Yields only when the queue is deep enough to matter.
 *
 * Yielding on every chunk costs a task per chunk, which is its own overhead.
 * Below the threshold the browser has no trouble keeping up, so we let it run.
 */
export function makeThrottledYielder(threshold = 8): {
  tick: (counter: number) => Promise<void> | void;
} {
  return {
    async tick(counter: number) {
      if (counter % threshold === 0) await yieldToEventLoop();
    },
  };
}

/** Exposed for tests and for choosing a strategy explicitly. */
export const yielders = {
  scheduler: schedulerYield,
  messageChannel: messageChannelYield,
  raf: rafYield,
  setTimeout: (): Promise<void> => new Promise((r) => setTimeout(r, 0)),
};

/**
 * Measures how long a strategy actually takes to yield 1000 times.
 *
 * Exists because the difference between `setTimeout(0)` and a MessageChannel
 * is invisible in a microbenchmark on Node and decisive in a browser, so the
 * claim is asserted structurally in tests rather than by timing.
 */
export function yieldCostEstimate(strategy: Yielder, iterations = 1000): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    // Intentionally not awaited: this is a structural estimate.
    void strategy();
  }
  return performance.now() - start;
}
