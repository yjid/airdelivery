/**
 * Incremental SHA-256.
 *
 * WHY NOT `crypto.subtle.digest`
 * ------------------------------
 * `SubtleCrypto.digest` takes the whole message at once. The previous
 * implementation called `sha256Hex(file)` on a `File` before sending, which
 * loads the entire file into memory. On a phone with a few hundred megabytes of
 * per-tab heap, hashing a 2 GB file was guaranteed to get the tab killed before
 * a single byte was transferred. On the receiving side it was worse: the
 * integrity check called `sha256Hex(await fileHandle.getFile())`, reading the
 * entire received file back off disk into RAM a second time.
 *
 * `SubtleCrypto` also has no streaming API, so there is no way to use it
 * incrementally.
 *
 * This implementation accepts chunks as they are already being read or written,
 * so hashing costs no additional memory and no additional I/O. It is pure
 * TypeScript so it is directly unit-testable against the NIST vectors.
 *
 * It is roughly an order of magnitude slower than native SHA-256, which is why
 * `hashFileFast` below still prefers `crypto.subtle` for small files.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export class Sha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  private readonly w = new Uint32Array(64);
  /** Partial block carried between updates. */
  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalBytes = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('Sha256: update() after digest()');

    this.totalBytes += data.byteLength;
    let offset = 0;

    // Top up a partial block first.
    if (this.bufferLength > 0) {
      const need = 64 - this.bufferLength;
      const take = Math.min(need, data.byteLength);
      this.buffer.set(data.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset = take;
      if (this.bufferLength === 64) {
        this.compress(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    // Then every whole block directly from the input, with no copy.
    while (offset + 64 <= data.byteLength) {
      this.compress(data, offset);
      offset += 64;
    }

    // Keep the tail.
    if (offset < data.byteLength) {
      const rest = data.subarray(offset);
      this.buffer.set(rest, 0);
      this.bufferLength = rest.byteLength;
    }

    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error('Sha256: digest() called twice');
    this.finished = true;

    const bitLength = this.totalBytes * 8;
    // Padding: 0x80, then zeros, then a 64-bit big-endian length.
    const padLength = this.bufferLength < 56 ? 56 - this.bufferLength : 120 - this.bufferLength;
    const tail = new Uint8Array(this.bufferLength + padLength + 8);
    tail.set(this.buffer.subarray(0, this.bufferLength), 0);
    tail[this.bufferLength] = 0x80;

    // Length is a 64-bit big-endian count. Split so we never exceed 2^53.
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.byteLength - 8, high, false);
    view.setUint32(tail.byteLength - 4, low, false);

    for (let offset = 0; offset < tail.byteLength; offset += 64) {
      this.compress(tail, offset);
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.h[i], false);
    return out;
  }

  hex(): string {
    return toHex(this.digest());
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.h;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    const hh = this.h;
    hh[0] = (hh[0] + a) >>> 0;
    hh[1] = (hh[1] + b) >>> 0;
    hh[2] = (hh[2] + c) >>> 0;
    hh[3] = (hh[3] + d) >>> 0;
    hh[4] = (hh[4] + e) >>> 0;
    hh[5] = (hh[5] + f) >>> 0;
    hh[6] = (hh[6] + g) >>> 0;
    hh[7] = (hh[7] + h) >>> 0;
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).hex();
}

/**
 * Native hashing for small inputs.
 *
 * `crypto.subtle` is roughly an order of magnitude faster than the TypeScript
 * implementation, so below this threshold it is worth one contiguous read.
 * Above it, the read itself becomes a memory problem, so we stream instead.
 */
export const NATIVE_HASH_LIMIT_BYTES = 64 * 1024 * 1024;

export function canUseSubtle(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.digest === 'function'
  );
}

export async function hashBlobNative(blob: Blob): Promise<string | undefined> {
  if (!canUseSubtle()) return undefined;
  try {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return toHex(new Uint8Array(digest));
  } catch {
    // Insecure context, quota, or an unexpected failure. Never fatal: the
    // transfer is still valid, it just cannot be verified.
    return undefined;
  }
}

/**
 * Hashes a whole blob without loading it all at once.
 *
 * Reads in slices so peak memory is one slice rather than one file.
 */
export async function hashBlobStreaming(blob: Blob): Promise<string | undefined> {
  if (typeof Blob.prototype.stream !== 'function') return undefined;
  try {
    const hasher = new Sha256();
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) hasher.update(value);
    }
    return hasher.hex();
  } catch {
    return undefined;
  }
}

export async function hashBlob(blob: Blob): Promise<string | undefined> {
  if (blob.size <= NATIVE_HASH_LIMIT_BYTES) return hashBlobNative(blob);
  return hashBlobStreaming(blob);
}
