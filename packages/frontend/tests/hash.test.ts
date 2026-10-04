/**
 * Incremental SHA-256 tests.
 *
 * Verified against the NIST vectors, then against `crypto.subtle`, then
 * against chunked feeds — because the point of this implementation is that the
 * result must not depend on how the input happened to be split. A padding bug
 * only shows up at specific block boundaries, so the boundary cases are the
 * tests that matter here.
 */

import { describe, expect, test } from 'bun:test';
import { Sha256, canUseSubtle, hashBlobNative, sha256Hex, toHex } from '../lib/transfer/hash.ts';

/**
 * `hashBlobNative` returns `undefined` when SubtleCrypto is unavailable, which
 * it is on an insecure origin. These tests are about the hashing maths, so they
 * require the platform implementation to be reachable and say so loudly rather
 * than silently comparing against `undefined`.
 */
if (!canUseSubtle()) {
  throw new Error('crypto.subtle is unavailable, so these vectors cannot be verified');
}

async function native(blob: Blob): Promise<string> {
  const digest = await hashBlobNative(blob);
  if (digest === undefined) throw new Error('native hashing unexpectedly returned undefined');
  return digest;
}

const enc = new TextEncoder();

describe('NIST vectors', () => {
  test('empty input', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('"abc"', () => {
    expect(sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('the 448-bit vector', () => {
    expect(sha256Hex(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  test('the 896-bit vector', () => {
    expect(
      sha256Hex(
        enc.encode(
          'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
        ),
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  test('one million "a" characters', () => {
    // This is the classic long vector and it exercises multi-block state.
    const hasher = new Sha256();
    const block = enc.encode('a'.repeat(1000));
    for (let i = 0; i < 1000; i++) hasher.update(block);
    expect(hasher.hex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
});

describe('block boundary behaviour', () => {
  // Padding is the classic place to get this wrong, so every length from 0 to
  // 130 is checked against the platform implementation.
  test('agrees with crypto.subtle for every length up to three blocks', async () => {
    const data = new Uint8Array(200);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff;

    for (let length = 0; length <= 200; length++) {
      const slice = data.subarray(0, length);
      const expected = await native(new Blob([slice]));
      expect(sha256Hex(slice)).toBe(expected);
    }
  });

  test('a single byte at a time produces the same digest', async () => {
    const data = new Uint8Array(257);
    for (let i = 0; i < data.length; i++) data[i] = (i * 91 + 5) & 0xff;

    const byteAtATime = new Sha256();
    for (const byte of data) byteAtATime.update(new Uint8Array([byte]));

    const expected = await native(new Blob([data]));
    expect(byteAtATime.hex()).toBe(expected);
    expect(sha256Hex(data)).toBe(expected);
  });

  test('chunk sizes do not change the result', async () => {
    const data = new Uint8Array(5000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13) & 0xff;
    const expected = await native(new Blob([data]));

    for (const chunkSize of [1, 7, 63, 64, 65, 127, 128, 1000, 4096, 5000]) {
      const hasher = new Sha256();
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        hasher.update(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
      }
      expect(hasher.hex()).toBe(expected);
    }
  });

  test('an update that lands exactly on a block boundary is handled', async () => {
    const data = new Uint8Array(128);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    const hasher = new Sha256();
    hasher.update(data.subarray(0, 64));
    hasher.update(data.subarray(64, 128));
    expect(hasher.hex()).toBe(await native(new Blob([data])));
  });

  test('a large input crossing many blocks matches', async () => {
    const data = new Uint8Array(70_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 251) & 0xff;
    expect(sha256Hex(data)).toBe(await native(new Blob([data])));
  });
});

describe('state machine guards', () => {
  test('update after digest throws', () => {
    const hasher = new Sha256();
    hasher.digest();
    expect(() => hasher.update(new Uint8Array(1))).toThrow();
  });

  test('digest twice throws', () => {
    const hasher = new Sha256();
    hasher.digest();
    expect(() => hasher.digest()).toThrow();
  });

  test('chaining returns the same instance', () => {
    const hasher = new Sha256();
    expect(hasher.update(new Uint8Array(1))).toBe(hasher);
  });

  test('an empty update is harmless', () => {
    const hasher = new Sha256();
    hasher.update(new Uint8Array(0));
    expect(hasher.hex()).toBe(sha256Hex(new Uint8Array(0)));
  });
});

describe('corruption detection is meaningful', () => {
  test('a single flipped bit changes the digest', async () => {
    const a = new Uint8Array(1000).fill(7);
    const b = new Uint8Array(1000).fill(7);
    b[500] ^= 0x01;
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });

  test('reordering chunks changes the digest', () => {
    // This is why whole-file hashing is still needed on top of a per-chunk CRC:
    // a CRC cannot detect reordering, but a whole-file hash can.
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([4, 3, 2, 1]);
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });
});

describe('helpers', () => {
  test('toHex is lowercase and zero-padded', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
  });
});
