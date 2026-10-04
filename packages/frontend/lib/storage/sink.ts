/**
 * Receive-side storage strategies.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The old implementation chose between three sinks:
 *
 *   1. File System Access API when the user picked a folder (Chromium only)
 *   2. An in-memory array, buffered until the whole file arrived, capped at
 *      1.2 GB
 *   3. StreamSaver, imported dynamically
 *
 * None of those work on a phone, which is the most important device class for
 * this app:
 *
 *   - File System Access is Chromium-desktop only.
 *   - The 1.2 GB in-memory cap means receiving a 1.5 GB file on a phone tries to
 *     hold it in RAM and gets the tab OOM-killed. A modern phone has a
 *     per-tab JS heap budget measured in hundreds of megabytes, so the real
 *     failure threshold is far below our own "cap".
 *   - StreamSaver requires a service worker served at the origin root
 *     (`mitra.js`). This app's worker is an empty stub, so the import resolved
 *     and the download silently produced nothing on arrival.
 *
 * The replacement ladder is: OPFS, then File System Access, then blob.
 * OPFS (`navigator.storage.getDirectory()`) is the key addition — it is
 * available in Safari 17+ and Chrome on Android, so it is the only strategy
 * that streams an arbitrarily large file to disk on a phone without the user
 * picking a directory first.
 *
 * Every strategy exposes the same interface, and `resolveStrategy` reports what
 * the current device can actually do so the UI can explain itself rather than
 * failing at 90%.
 */

export type StorageKind = 'opfs' | 'fsAccess' | 'blob' | 'none';

export interface Sink {
  kind: StorageKind;
  /** Appends bytes. Resolves when they are durable enough to continue. */
  write(bytes: Uint8Array): Promise<void>;
  /** Finalises and returns a handle the UI can download or verify. */
  close(): Promise<SinkResult>;
  /** Discards partial data. */
  abort(): Promise<void>;
  /** Bytes written so far. */
  readonly written: number;
}

export interface SinkResult {
  kind: StorageKind;
  /** A URL the UI can hand to a download link or `open()`. */
  url: string | null;
  /** Present when the file landed somewhere the user chose. */
  path: string | null;
  /** Reads the file back, for post-transfer verification. */
  read?: () => Promise<Blob>;
  /** Releases any object URL. Must be called to avoid a memory leak. */
  dispose?: () => void;
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

export interface Capabilities {
  secureContext: boolean;
  opfs: boolean;
  fsAccess: boolean;
  webTransport: boolean;
  encodedStreams: boolean;
  schedulerYield: boolean;
  /** Estimated RAM budget for a single tab, when the browser reports it. */
  deviceMemoryGb: number | null;
  /** Coarse pointer means a phone or tablet. */
  coarsePointer: boolean;
}

let cachedCapabilities: Capabilities | null = null;

export function detectCapabilities(): Capabilities {
  if (cachedCapabilities) return cachedCapabilities;
  if (typeof window === 'undefined') {
    return {
      secureContext: true,
      opfs: false,
      fsAccess: false,
      webTransport: false,
      encodedStreams: false,
      schedulerYield: false,
      deviceMemoryGb: null,
      coarsePointer: false,
    };
  }

  const nav = navigator as Navigator & { deviceMemory?: number };

  cachedCapabilities = {
    // `crypto.subtle` and both storage APIs are gated on this. Over plain HTTP
    // — which is exactly what happens when testing between two devices on a
    // phone hotspot — integrity checking and disk streaming are unavailable,
    // and the app has to say so instead of silently degrading.
    secureContext: window.isSecureContext,
    opfs: typeof navigator.storage?.getDirectory === 'function',
    fsAccess: 'showDirectoryPicker' in window,
    webTransport: 'WebTransport' in window,
    encodedStreams:
      typeof window.RTCPeerConnection === 'function' &&
      'createEncodedStreams' in RTCPeerConnection.prototype,
    schedulerYield: typeof (globalThis.scheduler as { yield?: unknown })?.yield === 'function',
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
  };

  return cachedCapabilities;
}

export function resetCapabilitiesCache(): void {
  cachedCapabilities = null;
}

// ---------------------------------------------------------------------------
// OPFS sink
// ---------------------------------------------------------------------------

/**
 * Streams straight to the origin-private file system.
 *
 * `createSyncAccessHandle` is only available inside a Worker, so on the main
 * thread we use the async `createWritable` instead. The async path is
 * implemented on top of the sync handle in every shipping engine.
 */
async function createOpfsSink(path: string): Promise<Sink | null> {
  const dir = await navigator.storage.getDirectory();
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop() || 'file';

  let current = dir;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }

  const handle = await current.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  let written = 0;

  return {
    kind: 'opfs',
    get written() {
      return written;
    },
    async write(bytes: Uint8Array) {
      await writable.write(bytes as unknown as BufferSource);
      written += bytes.byteLength;
    },
    async close() {
      await writable.close();
      const file = await handle.getFile();
      return {
        kind: 'opfs',
        url: URL.createObjectURL(file),
        path: name,
        read: async () => file,
        dispose: () => {},
      };
    },
    async abort() {
      try {
        await writable.abort();
      } catch {
        // Already closed or never opened. Nothing to undo.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// File System Access sink
// ---------------------------------------------------------------------------

let chosenDirectory: FileSystemDirectoryHandle | null = null;

export function supportsFSAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export function hasChosenDirectory(): boolean {
  return chosenDirectory !== null;
}

export function chosenDirectoryName(): string | null {
  return chosenDirectory?.name ?? null;
}

/**
 * Must be called from a user gesture. Returns the directory name, or null if
 * the user cancelled or the API is unavailable.
 */
export async function chooseDirectory(): Promise<string | null> {
  if (!supportsFSAccess()) return null;
  try {
    chosenDirectory = await (
      window as unknown as {
        showDirectoryPicker: (o: unknown) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ mode: 'readwrite' });
    return chosenDirectory.name;
  } catch {
    // AbortError when the user dismisses the picker. Not an error worth surfacing.
    return null;
  }
}

export function clearDirectory(): void {
  chosenDirectory = null;
}

async function createFsAccessSink(path: string): Promise<Sink | null> {
  if (!chosenDirectory) return null;
  try {
    const segments = path.split('/').filter(Boolean);
    const name = segments.pop() || 'file';
    let dir = chosenDirectory;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let written = 0;

    return {
      kind: 'fsAccess',
      get written() {
        return written;
      },
      async write(bytes: Uint8Array) {
        await writable.write(bytes as unknown as BufferSource);
        written += bytes.byteLength;
      },
      async close() {
        await writable.close();
        return {
          kind: 'fsAccess',
          url: null,
          path: `${dir.name}/${name}`,
          read: async () => handle.getFile(),
        };
      },
      async abort() {
        try {
          await writable.abort();
        } catch {
          // Already closed.
        }
      },
    };
  } catch {
    // Permission revoked mid-transfer, or the directory was removed.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Blob sink — the last resort, and the only one that buffers in RAM.
// ---------------------------------------------------------------------------

/**
 * Above this size we refuse to buffer in memory rather than OOM the tab.
 *
 * The old limit was 1.2 GB, which no mobile browser could survive. Anything
 * over the limit still works if the user picks a directory or OPFS is
 * available; it only becomes impossible on a device with neither, which is
 * surfaced to the user as "choose a folder to receive this file".
 */
export const MAX_IN_MEMORY_BYTES = 256 * 1024 * 1024;

function createBlobSink(path: string, declaredSize: number): Sink {
  const parts: Uint8Array[] = [];
  let written = 0;
  let url: string | null = null;

  return {
    kind: 'blob',
    get written() {
      return written;
    },
    async write(bytes: Uint8Array) {
      // Copy: the caller reuses its buffer between chunks.
      parts.push(bytes.slice());
      written += bytes.byteLength;
    },
    async close() {
      const blob = new Blob(parts as BlobPart[], {
        type: 'application/octet-stream',
      });
      parts.length = 0;
      url = URL.createObjectURL(blob);
      return {
        kind: 'blob',
        url,
        path: path.split('/').pop() ?? path,
        read: async () => blob,
        dispose: () => {
          if (url) URL.revokeObjectURL(url);
          url = null;
        },
      };
    },
    async abort() {
      parts.length = 0;
      written = 0;
    },
    // Exposed so the UI can warn before starting an oversized transfer.
    declaredSize,
  } as Sink & { declaredSize: number };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Picks the best available sink for a file of `size` bytes.
 *
 * Order matters: a user-chosen directory is preferred over OPFS because the
 * user can find the file afterwards, and OPFS is preferred over blob because
 * it does not consume the heap.
 */
export async function createSink(path: string, size: number): Promise<Sink> {
  if (hasChosenDirectory()) {
    const sink = await createFsAccessSink(path);
    if (sink) return sink;
    // The handle went stale — fall through rather than failing the transfer.
    clearDirectory();
  }

  if (detectCapabilities().opfs) {
    try {
      const sink = await createOpfsSink(path);
      if (sink) return sink;
    } catch {
      // Quota exceeded or OPFS unavailable in this context.
    }
  }

  if (size <= MAX_IN_MEMORY_BYTES) {
    return createBlobSink(path, size);
  }

  // Nothing can handle this safely. Return a sink that fails loudly on first
  // write rather than silently OOM-ing at some arbitrary later point.
  return {
    kind: 'none',
    written: 0,
    async write() {
      throw new Error(
        'This device cannot store a file this large in memory. Choose a folder to receive it.',
      );
    },
    async close() {
      throw new Error('No storage strategy available.');
    },
    async abort() {
      /* nothing to clean up */
    },
  };
}

/** Explains the ladder to the UI. */
export function describeStrategy(kind: StorageKind): string {
  switch (kind) {
    case 'opfs':
      return 'Streaming to device storage';
    case 'fsAccess':
      return 'Saving to your folder';
    case 'blob':
      return 'Held in memory until you save it';
    case 'none':
      return 'Unsupported on this device';
  }
}
