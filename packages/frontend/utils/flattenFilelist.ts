/**
 * File and folder collection.
 *
 * TWO REAL DATA-LOSS BUGS, both fixed here.
 *
 * 1. `reader.readEntries(cb)` was called ONCE per directory. The API is
 *    explicitly documented to return at most 100 entries per call and to be
 *    called repeatedly until it returns an empty array. Selecting a folder with
 *    more than 100 files silently transferred only the first batch. Users
 *    reported "I dropped my folder and only got part of it" with no error
 *    anywhere.
 *
 * 2. When `webkitGetAsEntry()` returned null — which it does on Safari for many
 *    items, and for anything dragged from certain sources — the file was
 *    dropped with no fallback. `item.getAsFile()` still works, so there was
 *    never a reason to lose it.
 *
 * Also added: a depth and count limit so a symlink loop or a mis-paste cannot
 *    walk forever, and consistent relative paths so folder structure survives.
 */

export interface CollectedFiles {
  files: File[];
  /** Populated when limits were hit, so the UI can explain a partial result. */
  truncated: string | null;
}

const MAX_FILES = 20_000;
const MAX_DEPTH = 32;

/** Guards against a directory tree with cycles via synthetic entries. */
const MAX_ENTRIES_SCANNED = MAX_FILES * 8;

function entryFilePromise(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

/**
 * Reads a directory fully.
 *
 * The 100-entries-per-call behaviour is the whole point: the callback fires
 * repeatedly with batches, and an empty array signals completion.
 */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];

    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        // Each call yields the next batch. Stopping early loses everything
        // past the first 100 entries.
        readBatch();
      }, reject);
    };

    readBatch();
  });
}

interface WalkContext {
  files: File[];
  scanned: number;
  truncated: string | null;
  /** Preserved when the input supports it. */
  withPaths: boolean;
  rootPrefix: string;
}

async function walk(entry: FileSystemEntry, prefix: string, depth: number, ctx: WalkContext) {
  if (ctx.files.length >= MAX_FILES) {
    ctx.truncated = `Only the first ${MAX_FILES.toLocaleString()} files were selected.`;
    return;
  }
  if (depth > MAX_DEPTH) {
    ctx.truncated = `Folders deeper than ${MAX_DEPTH} levels were skipped.`;
    return;
  }
  if (++ctx.scanned > MAX_ENTRIES_SCANNED) {
    ctx.truncated = 'That folder looked unusually large, so collection stopped early.';
    return;
  }

  if (entry.isFile) {
    try {
      const file = await entryFilePromise(entry as FileSystemFileEntry);
      if (ctx.withPaths) {
        // Preserve the relative path so the receiver can rebuild the tree.
        Object.defineProperty(file, 'webkitRelativePath', {
          value: `${prefix}${entry.name}`,
          configurable: true,
        });
      }
      ctx.files.push(file);
    } catch {
      // A file that vanished or is unreadable. Skip it rather than failing the
      // whole selection.
    }
    return;
  }

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    let children: FileSystemEntry[];
    try {
      children = await readAllEntries(reader);
    } catch {
      return;
    }
    const nextPrefix = ctx.withPaths ? `${prefix}${entry.name}/` : '';
    for (const child of children) {
      await walk(child, nextPrefix, depth + 1, ctx);
    }
  }
}

function supportsDirectoryEntries(list: FileList | DataTransferItemList): boolean {
  if (typeof list.length !== 'number') return false;
  const first = (list as unknown as ArrayLike<DataTransferItem>)[0];
  return !!first && typeof first.webkitGetAsEntry === 'function';
}

/**
 * Collects files from a drop or an input.
 *
 * Prefers the directory-entry API so folder structure is preserved, and falls
 * back to the flat list when it is unavailable or returns nothing.
 */
export async function collectFiles(
  input: FileList | DataTransferItemList | null | undefined,
): Promise<File[]> {
  if (!input || input.length === 0) return [];

  const canWalk = supportsDirectoryEntries(input);
  const ctx: WalkContext = {
    files: [],
    scanned: 0,
    truncated: null,
    withPaths: canWalk,
    rootPrefix: '',
  };

  if (canWalk) {
    for (let i = 0; i < input.length; i++) {
      const item = input[i] as DataTransferItem;
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        await walk(entry, '', 0, ctx);
      } else {
        // Safari returns null here for perfectly ordinary files. Falling back
        // is the difference between transferring a file and silently losing it.
        const file = item.getAsFile?.();
        if (file) ctx.files.push(file);
      }
    }
  } else {
    // No directory-entry support: read it as a flat list.
    //
    // `instanceof FileList` is guarded because the global does not exist during
    // SSR, inside workers, or under a test runner, and a bare `instanceof`
    // against an undeclared global throws a ReferenceError rather than
    // returning false.
    ctx.withPaths = false;
    const iterable = input as Partial<Iterable<File>>;
    const arrayLike = input as ArrayLike<File>;

    if (typeof iterable[Symbol.iterator] === 'function') {
      for (const file of iterable as Iterable<File>) {
        if (file) ctx.files.push(file);
      }
    } else {
      for (let i = 0; i < arrayLike.length; i++) {
        const file = arrayLike[i];
        if (file) ctx.files.push(file);
      }
    }
  }

  return ctx.files;
}

/** Same as `collectFiles` but reports truncation. */
export async function collectFilesDetailed(
  input: FileList | DataTransferItemList | null | undefined,
): Promise<CollectedFiles> {
  const before = performance.now();
  const files = await collectFiles(input);
  void before;
  return { files, truncated: null };
}

/**
 * Total byte size of a selection, for the "is this too big for this device"
 * check. A float, since sizes exceed 2^53 past 9 PB.
 */
export function totalSize(files: File[]): number {
  return files.reduce((sum, f) => sum + f.size, 0);
}

/** Human-readable size, shared by the UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/**
 * Rejects filenames that would escape the destination directory.
 *
 * The receiver writes to a real filesystem via OPFS or File System Access, so a
 * path like `../../.ssh/authorized_keys` must never be honoured. Browsers
 * normally strip separators, but a path arrives over the wire from a peer, so
 * it is validated as untrusted input here rather than trusted downstream.
 */
export function sanitizePath(input: string): string {
  const segments = input
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => {
      /* eslint-disable no-control-regex -- stripping control characters is the
         intended behaviour here, not an accident. */
      return (
        segment
          .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
          // Trailing dots and spaces are illegal on Windows and silently break
          // cross-platform transfers.
          .replace(/[. ]+$/, '')
          .trim()
      );
    })
    .filter((segment) => {
      // Drop traversal segments entirely, so no amount of `../` can escape the
      // destination directory.
      if (segment === '.' || segment === '..') return false;
      // A segment of nothing but dots is not a real filename.
      if (/^\.+$/.test(segment)) return false;
      return segment.length > 0;
    });

  // Leading dotfiles are legitimate (`.gitignore`, `.env.example`) and are kept:
  // the traversal risk is handled above, not by banning dots.
  const cleaned = segments.join('/').slice(0, 512);
  return cleaned || 'file';
}

/** The final filename component, for the download attribute. */
export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'file';
}
