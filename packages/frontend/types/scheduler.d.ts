/**
 * `scheduler.yield()` ships in Chromium but is not yet in TypeScript's DOM
 * library. It is the fastest cooperative-yield primitive available, so we probe
 * for it at runtime behind these declarations.
 */
declare global {
  var scheduler: Scheduler | undefined;

  interface Scheduler {
    yield?: () => Promise<void>;
    postTask?: <T>(callback: () => T, options?: { priority?: string }) => Promise<T>;
  }
}

export {};
