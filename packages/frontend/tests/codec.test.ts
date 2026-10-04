/**
 * Wire codec and reassembly tests.
 *
 * The codec replaced an implementation that had three data-corruption bugs,
 * each pinned here:
 *
 *  - `unpack` read a header with no length check, so a truncated frame threw a
 *    RangeError out of a message handler.
 *  - `rec.queue.push(decompressed.buffer)` pushed the whole underlying buffer
 *    rather than the view, so `received` could over-count and the written file
 *    would not match its hash.
 *  - There was no reassembly at all, because the channel was fully reliable
 *    and ordered. The new channels are partially reliable, so out-of-order is
 *    now expected and has to be handled.
 */

import { describe, expect, test } from 'bun:test';
import {
  CHUNK_HEADER_BYTES,
  ChunkDecodeError,
  FLAG_LZ4,
  MAX_CHUNK_PAYLOAD,
  Reassembler,
  crc32,
  decodeChunk,
  encodeChunk,
  isKnownCompressed,
  shouldCompressSample,
  verifyChunk,
} from '../lib/transfer/codec.ts';

const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);

describe('encode/decode round trip', () => {
  test('an uncompressed chunk survives the round trip', () => {
    const payload = bytes(1024);
    const decoded = decodeChunk(encodeChunk(1, 0, payload, false));
    expect(decoded.sessionId).toBe(1);
    expect(decoded.sequence).toBe(0);
    expect(decoded.isCompressed).toBe(false);
    expect(decoded.payload).toEqual(payload);
  });

  test('a compressed chunk is flagged and survives', () => {
    const payload = bytes(512);
    const frame = encodeChunk(7, 9, payload, true);
    expect(new DataView(frame).getUint8(8)).toBe(FLAG_LZ4);
    const decoded = decodeChunk(frame);
    expect(decoded.isCompressed).toBe(true);
    expect(decoded.payload).toEqual(payload);
  });

  test('an uncompressed chunk has no flag bits set', () => {
    const frame = encodeChunk(7, 9, bytes(16), false);
    expect(new DataView(frame).getUint8(8)).toBe(0);
  });

  test('session and sequence survive the u16 boundary', () => {
    const decoded = decodeChunk(encodeChunk(0xffff, 0xffff, bytes(1), false));
    expect(decoded.sessionId).toBe(0xffff);
    expect(decoded.sequence).toBe(0xffff);
  });

  test('session ids wrap rather than corrupting', () => {
    // 16-bit sessions mean a long-lived flight wraps. That is fine because
    // transfers never overlap within a flight.
    const decoded = decodeChunk(encodeChunk(0x10000, 1, bytes(1), false));
    expect(decoded.sessionId).toBe(0);
  });

  test('the header is exactly 11 bytes', () => {
    expect(encodeChunk(1, 1, bytes(0), false).byteLength).toBe(CHUNK_HEADER_BYTES);
    expect(encodeChunk(1, 1, bytes(100), false).byteLength).toBe(CHUNK_HEADER_BYTES + 100);
  });

  test('an empty payload is legal — the final chunk of a sized file', () => {
    const decoded = decodeChunk(encodeChunk(1, 5, bytes(0), false));
    expect(decoded.payload.byteLength).toBe(0);
  });

  test('the payload is copied, not aliased', () => {
    // Handing an alias to a decompressor that retains it is how corruption
    // appears once buffers are pooled.
    const source = bytes(64);
    const frame = encodeChunk(1, 0, source, false);
    const decoded = decodeChunk(frame);
    source.fill(0);
    expect(decoded.payload.some((b) => b === 0)).toBe(false);
  });

  test('encoding a payload that cannot fit is rejected', () => {
    expect(() => encodeChunk(1, 0, bytes(MAX_CHUNK_PAYLOAD + 1), false)).toThrow(RangeError);
  });
});

describe('decode rejects malformed frames', () => {
  test('a truncated frame is rejected, not thrown out of a handler', () => {
    // This is the crash the old `unpack` produced.
    expect(() => decodeChunk(new ArrayBuffer(4))).toThrow(ChunkDecodeError);
    try {
      decodeChunk(new ArrayBuffer(4));
    } catch (err) {
      expect((err as ChunkDecodeError).reason).toBe('too-short');
    }
  });

  test('an empty buffer is rejected', () => {
    expect(() => decodeChunk(new ArrayBuffer(0))).toThrow(ChunkDecodeError);
  });

  test('a length field that disagrees with the frame is rejected', () => {
    const frame = encodeChunk(1, 0, bytes(64), false);
    // Inflate the declared payload length.
    new DataView(frame).setUint32(4, 128, true);
    try {
      decodeChunk(frame);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ChunkDecodeError).reason).toBe('length-mismatch');
    }
  });

  test('an absurd declared length is rejected', () => {
    const frame = encodeChunk(1, 0, bytes(64), false);
    new DataView(frame).setUint32(4, 0xffffffff, true);
    expect(() => decodeChunk(frame)).toThrow(ChunkDecodeError);
  });

  test('unknown flag bits are rejected', () => {
    const frame = encodeChunk(1, 0, bytes(8), false);
    new DataView(frame).setUint8(8, 0b1000_0000);
    try {
      decodeChunk(frame);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ChunkDecodeError).reason).toBe('bad-flags');
    }
  });

  test('a non-ArrayBuffer is rejected', () => {
    for (const bad of [null, undefined, 'string', 42, {}, new Uint8Array(16)]) {
      expect(() => decodeChunk(bad as never)).toThrow(ChunkDecodeError);
    }
  });
});

describe('crc32', () => {
  test('is deterministic', () => {
    expect(crc32(bytes(100))).toBe(crc32(bytes(100)));
  });

  test('changes when the payload changes', () => {
    expect(crc32(bytes(100, 1))).not.toBe(crc32(bytes(100, 2)));
  });

  test('handles an empty payload', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  test('matches the known IEEE vector for "123456789"', () => {
    const input = new TextEncoder().encode('123456789');
    expect(crc32(input)).toBe(0xcbf43926);
  });
});

describe('per-chunk integrity', () => {
  test('an untouched chunk verifies', () => {
    expect(verifyChunk(decodeChunk(encodeChunk(1, 0, bytes(256), false)))).toBe(true);
  });

  test('a corrupted payload fails verification', () => {
    const frame = encodeChunk(1, 0, bytes(256, 9), false);
    const payload = new Uint8Array(frame, CHUNK_HEADER_BYTES, 256);
    payload[10] ^= 0xff;
    expect(verifyChunk(decodeChunk(frame))).toBe(false);
  });
});

describe('Reassembler', () => {
  test('in-order chunks pass straight through', () => {
    const r = new Reassembler();
    expect(r.push(0, bytes(1, 1))).toHaveLength(1);
    expect(r.push(1, bytes(1, 2))).toHaveLength(1);
    expect(r.expected).toBe(2);
  });

  test('an out-of-order chunk is buffered, then drained', () => {
    const r = new Reassembler();
    expect(r.push(1, bytes(1, 2))).toHaveLength(0);
    expect(r.pendingCount).toBe(1);
    const drained = r.push(0, bytes(1, 1));
    expect(drained).toHaveLength(2);
    expect(drained[0][0]).toBe(1);
    expect(drained[1][0]).toBe(2);
    expect(r.pendingCount).toBe(0);
  });

  test('a long out-of-order run drains fully', () => {
    const r = new Reassembler();
    for (let i = 0; i < 4; i++) r.push(i, bytes(1, i));
    for (let i = 9; i >= 5; i--) r.push(i, bytes(1, i));
    expect(r.pendingCount).toBe(5);
    // Filling the gap releases the new chunk plus all five behind it.
    const drained = r.push(4, bytes(1, 4));
    expect(drained).toHaveLength(6);
    expect(r.expected).toBe(10);
    expect(r.pendingCount).toBe(0);
  });

  test('duplicates are ignored', () => {
    const r = new Reassembler();
    r.push(0, bytes(1, 1));
    expect(r.push(0, bytes(1, 1))).toHaveLength(0);
    expect(r.expected).toBe(1);
  });

  test('a gap eventually reports itself as stalled', () => {
    const r = new Reassembler(1000);
    r.push(1, bytes(1), 10_000);
    expect(r.isStalled(10_500)).toBe(false);
    expect(r.isStalled(12_000)).toBe(true);
  });

  test('a gap recorded at epoch zero is still detected as a gap', () => {
    // 0 used to be the "no gap" sentinel, so a gap opened at timestamp 0 was
    // never reported as stalled.
    const r = new Reassembler(1000);
    r.push(1, bytes(1), 0);
    expect(r.isStalled(0)).toBe(false);
    expect(r.isStalled(2000)).toBe(true);
  });

  test('a gap clears once filled', () => {
    const r = new Reassembler(1000);
    r.push(1, bytes(1), 0);
    r.push(0, bytes(1), 500);
    expect(r.isStalled(2000)).toBe(false);
  });

  test('missing sequences are reportable', () => {
    const r = new Reassembler();
    r.push(0, bytes(1));
    r.push(3, bytes(1));
    expect(r.missing()).toContain(1);
    expect(r.missing()).toContain(2);
  });

  test('reset clears everything', () => {
    const r = new Reassembler();
    r.push(5, bytes(1));
    r.reset();
    expect(r.expected).toBe(0);
    expect(r.pendingCount).toBe(0);
  });

  test('no gap means nothing is ever reported missing', () => {
    const r = new Reassembler();
    r.push(0, bytes(1));
    expect(r.missing()).toEqual([]);
  });
});

describe('compression decisions', () => {
  test('already-compressed extensions are skipped', () => {
    for (const name of ['a.zip', 'a.mp4', 'a.jpg', 'a.pdf', 'a.gz', 'a.woff2', 'A.PNG']) {
      expect(isKnownCompressed(name)).toBe(true);
    }
  });

  test('compressible-looking extensions are not skipped', () => {
    for (const name of ['a.txt', 'a.csv', 'a.json', 'a.rs', 'noext']) {
      expect(isKnownCompressed(name)).toBe(false);
    }
  });

  test('an ambiguous extension is resolved by MIME type, not guessed', () => {
    // `.ts` is TypeScript source OR an MPEG transport stream. Guessing either
    // way is wrong, so the extension alone must not decide.
    expect(isKnownCompressed('a.ts')).toBe(false);
    expect(isKnownCompressed('a.ts', 'video/mp2t')).toBe(true);
    expect(isKnownCompressed('a.ts', 'text/plain')).toBe(false);
  });

  test('MIME type beats a misleading extension', () => {
    // A .zip that is actually text should still be compressed.
    expect(isKnownCompressed('a.zip', 'text/plain')).toBe(false);
    expect(isKnownCompressed('a.zip', 'application/zip')).toBe(true);
    expect(isKnownCompressed('a.txt', 'image/png')).toBe(true);
  });

  test('MIME parameters are ignored', () => {
    expect(isKnownCompressed('a.bin', 'text/plain; charset=utf-8')).toBe(false);
    expect(isKnownCompressed('a.bin', 'image/jpeg;charset=binary')).toBe(true);
  });

  test('a worthwhile saving is accepted', () => {
    expect(shouldCompressSample('a.txt', 1000, 400)).toBe(true);
  });

  test('a negligible saving is refused', () => {
    // Below the threshold the CPU cost on a phone is not worth the bandwidth.
    expect(shouldCompressSample('a.txt', 1000, 985)).toBe(false);
  });

  test('an expansion is refused', () => {
    expect(shouldCompressSample('a.txt', 1000, 1200)).toBe(false);
  });

  test('an already-compressed file is refused regardless of the saving', () => {
    expect(shouldCompressSample('a.zip', 1000, 100)).toBe(false);
  });

  test('an empty sample is refused', () => {
    expect(shouldCompressSample('a.txt', 0, 0)).toBe(false);
  });
});
