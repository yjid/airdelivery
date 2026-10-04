/**
 * File collection and path-safety tests.
 *
 * The folder-selection tests exist because of a silent data-loss bug: the old
 * implementation called `readEntries()` once and stopped, and the API is
 * documented to return at most 100 entries per call. Anything past the first
 * hundred files in a folder simply never got transferred, with no error shown
 * anywhere. These tests fake a directory reader that batches, which is exactly
 * what a real one does.
 */

import { describe, expect, test } from 'bun:test';
import {
  baseName,
  collectFiles,
  formatBytes,
  sanitizePath,
  totalSize,
} from '../utils/flattenFilelist.ts';

// ---------------------------------------------------------------------------
// Fakes that reproduce the real API's batching behaviour
// ---------------------------------------------------------------------------

/**
 * A FileSystemDirectoryReader that hands back `batchSize` entries per call and
 * only returns an empty array once drained — the documented contract.
 */
function makeDirectoryReader(
  entries: Array<{ name: string; kind: 'file' | 'dir' }>,
  batchSize = 100,
) {
  let cursor = 0;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    readEntries(onSuccess: (batch: unknown[]) => void) {
      calls += 1;
      if (cursor >= entries.length) {
        onSuccess([]);
        return;
      }
      const batch = entries.slice(cursor, cursor + batchSize);
      cursor += batch.length;
      onSuccess(batch.map((e) => makeEntry(e.name, e.kind)));
    },
  };
}

function makeFile(name: string, contents = 'x'): File {
  return new File([contents], name);
}

function makeEntry(name: string, kind: 'file' | 'dir'): any {
  if (kind === 'file') {
    return {
      isFile: true,
      isDirectory: false,
      name,
      file: (cb: (f: File) => void) => cb(makeFile(name)),
    };
  }
  // The tree is defined by a module-level registry so the fake stays simple.
  const children = registry.get(name) ?? [];
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => makeDirectoryReader(children),
  };
}

const registry = new Map<string, Array<{ name: string; kind: 'file' | 'dir' }>>();

/** Builds a DataTransferItemList-alike. */
function itemList(items: Array<{ entry?: any; file?: File | null }>): any {
  const list: any = {
    length: items.length,
    [Symbol.iterator]: function* () {
      for (const item of items) yield item;
    },
  };
  items.forEach((item, i) => {
    list[i] = {
      kind: 'file',
      webkitGetAsEntry: () => item.entry ?? null,
      getAsFile: () => item.file ?? null,
    };
  });
  return list;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectFiles', () => {
  test('an empty input yields nothing', async () => {
    expect(await collectFiles(null)).toEqual([]);
    expect(await collectFiles(undefined)).toEqual([]);
    expect(await collectFiles({ length: 0 } as never)).toEqual([]);
  });

  test('files with no entries fall back to getAsFile', async () => {
    // This is the Safari case: webkitGetAsEntry() returns null for ordinary
    // files, and the old code dropped them silently.
    const a = makeFile('a.txt');
    const b = makeFile('b.txt');
    const result = await collectFiles(itemList([{ file: a }, { file: b }]));
    expect(result.map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
  });

  test('a mixed list uses whichever source works per item', async () => {
    const loose = makeFile('loose.txt');
    registry.set('Folder', [{ name: 'nested.txt', kind: 'file' }]);
    const folderEntry = makeEntry('Folder', 'dir');

    const result = await collectFiles(itemList([{ entry: folderEntry }, { file: loose }]));
    expect(result.map((f) => f.name).sort()).toEqual(['loose.txt', 'nested.txt']);
  });

  test('an entry that yields nothing and has no fallback is skipped, not fatal', async () => {
    const result = await collectFiles(itemList([{ entry: null, file: null }]));
    expect(result).toEqual([]);
  });
});

describe('directory traversal past 100 entries', () => {
  test('more than 100 files in one folder are all collected', async () => {
    // THE DATA-LOSS BUG. A single readEntries() call returned at most 100 and
    // the rest of the folder was never transferred.
    const count = 250;
    const children = Array.from({ length: count }, (_, i) => ({
      name: `file${String(i).padStart(3, '0')}.txt`,
      kind: 'file' as const,
    }));
    registry.set('Big', children);

    const result = await collectFiles(itemList([{ entry: makeEntry('Big', 'dir') }]));

    expect(result).toHaveLength(count);
    expect(result.map((f) => f.name)).toContain('file249.txt');
  });

  test('exactly 100 files is handled', async () => {
    const children = Array.from({ length: 100 }, (_, i) => ({
      name: `f${i}.txt`,
      kind: 'file' as const,
    }));
    registry.set('Exactly100', children);
    const result = await collectFiles(itemList([{ entry: makeEntry('Exactly100', 'dir') }]));
    expect(result).toHaveLength(100);
  });

  test('a nested tree is fully traversed', async () => {
    registry.set('Root', [
      { name: 'A', kind: 'dir' },
      { name: 'top.txt', kind: 'file' },
    ]);
    registry.set('A', [
      { name: 'B', kind: 'dir' },
      { name: 'a1.txt', kind: 'file' },
    ]);
    registry.set('B', [{ name: 'b1.txt', kind: 'file' }]);

    const result = await collectFiles(itemList([{ entry: makeEntry('Root', 'dir') }]));
    const names = result.map((f) => f.name).sort();
    expect(names).toEqual(['a1.txt', 'b1.txt', 'top.txt']);
  });

  test('a nested tree larger than one batch per level is complete', async () => {
    registry.set('Deep', [{ name: 'sub', kind: 'dir' }]);
    registry.set('sub', [
      ...Array.from({ length: 150 }, (_, i) => ({ name: `s${i}.txt`, kind: 'file' as const })),
      { name: 'deeper', kind: 'dir' },
    ]);
    registry.set('deeper', [{ name: 'leaf.txt', kind: 'file' }]);

    const result = await collectFiles(itemList([{ entry: makeEntry('Deep', 'dir') }]));
    expect(result).toHaveLength(151);
    expect(result.map((f) => f.name)).toContain('leaf.txt');
  });

  test('an empty directory yields nothing rather than hanging', async () => {
    registry.set('Empty', []);
    const result = await collectFiles(itemList([{ entry: makeEntry('Empty', 'dir') }]));
    expect(result).toEqual([]);
  });

  test('relative paths are preserved so the tree can be rebuilt', async () => {
    registry.set('Project', [{ name: 'src', kind: 'dir' }]);
    registry.set('src', [{ name: 'index.ts', kind: 'file' }]);

    const result = await collectFiles(itemList([{ entry: makeEntry('Project', 'dir') }]));
    expect((result[0] as File & { webkitRelativePath: string }).webkitRelativePath).toBe(
      'Project/src/index.ts',
    );
  });

  test('an unreadable directory does not abort the whole selection', async () => {
    registry.set('Root', [{ name: 'ok.txt', kind: 'file' }]);
    const badDir: any = {
      isFile: false,
      isDirectory: true,
      name: 'Bad',
      createReader: () => ({
        readEntries(_ok: (b: unknown[]) => void, fail: (e: unknown) => void) {
          fail(new Error('permission denied'));
        },
      }),
    };
    const result = await collectFiles(
      itemList([{ entry: badDir }, { entry: makeEntry('Root', 'dir') }]),
    );
    expect(result.map((f) => f.name)).toEqual(['ok.txt']);
  });
});

describe('FileList input', () => {
  test('a plain FileList is read directly', async () => {
    const list = {
      length: 2,
      0: makeFile('one.txt'),
      1: makeFile('two.txt'),
    };
    // Not a real FileList, so the instanceof branch is skipped and the
    // iterator path is used.
    Object.setPrototypeOf(list, Object.prototype);
    const result = await collectFiles(list as unknown as FileList);
    expect(result).toHaveLength(2);
  });
});

describe('sanitizePath — the receiver writes to a real filesystem', () => {
  test('plain names pass through', () => {
    expect(sanitizePath('report.pdf')).toBe('report.pdf');
    expect(sanitizePath('a/b/c.txt')).toBe('a/b/c.txt');
  });

  test('traversal segments are removed', () => {
    // A path arrives over the wire from a peer, so it is untrusted input. If
    // this reached OPFS or File System Access unfiltered, a sender could choose
    // where on the receiver's disk the file landed.
    expect(sanitizePath('../../.ssh/authorized_keys')).toBe('.ssh/authorized_keys');
    expect(sanitizePath('a/../../b')).toBe('a/b');
    expect(sanitizePath('..')).toBe('file');
    expect(sanitizePath('./')).toBe('file');
  });

  test('backslashes are normalised before traversal checks', () => {
    expect(sanitizePath('..\\..\\evil.txt')).toBe('evil.txt');
  });

  test('absolute paths lose their root', () => {
    expect(sanitizePath('/etc/passwd')).toBe('etc/passwd');
  });

  test('control characters are stripped', () => {
    expect(sanitizePath('a\u0000b.txt')).toBe('a_b.txt');
    expect(sanitizePath('a\nb.txt')).toBe('a_b.txt');
  });

  test('characters illegal on Windows are replaced', () => {
    expect(sanitizePath('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  test('legitimate dotfiles are preserved', () => {
    // Banning leading dots would break .gitignore and .env.example. Traversal
    // is prevented by removing `..` segments, not by banning dots.
    expect(sanitizePath('.bashrc')).toBe('.bashrc');
    expect(sanitizePath('a/.gitignore')).toBe('a/.gitignore');
  });

  test('a segment of only dots is not a filename', () => {
    expect(sanitizePath('...')).toBe('file');
    expect(sanitizePath('a/.../b')).toBe('a/b');
  });

  test('trailing dots and spaces are stripped, which Windows requires', () => {
    expect(sanitizePath('report.txt.')).toBe('report.txt');
    expect(sanitizePath('report.txt   ')).toBe('report.txt');
  });

  test('empty and overlong inputs are handled', () => {
    expect(sanitizePath('')).toBe('file');
    expect(sanitizePath('   ')).toBe('file');
    expect(sanitizePath('a'.repeat(2000)).length).toBeLessThanOrEqual(512);
  });

  test('a filename with no directory keeps its name', () => {
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(baseName('solo.txt')).toBe('solo.txt');
    expect(baseName('')).toBe('file');
  });
});

describe('formatting helpers', () => {
  test('totalSize sums a selection', () => {
    const a = new File([new Uint8Array(100)], 'a');
    const b = new File([new Uint8Array(250)], 'b');
    expect(totalSize([a, b])).toBe(350);
    expect(totalSize([])).toBe(0);
  });

  test('formatBytes picks a sensible unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.00 MB');
    expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.50 GB');
  });

  test('formatBytes survives nonsense input', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});
