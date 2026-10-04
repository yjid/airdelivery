/**
 * Binary chunk codec.
 *
 * Split out of the React hook precisely so it can be tested without a browser,
 * a socket, or a React tree. Everything here runs on the hot path — once per
 * chunk, thousands of times per second — so the encoding is allocation-light
 * and the layout is fixed-width.
 *
 * Wire format (little-endian, no padding):
 *
 *   offset  size  field
 *   0       2     u16   sessionId
 *   2       2     u16   sequence
 *   4       4     u32   payloadLength
 *   8       1     u8    flags        bit0 = lz4 compressed
 *   9       2     u16   crc32        of the payload as received
 *   11      ...   payload
 *
 * Why this differs from the previous format
 * ------------------------------------------
 * The old header repeated the transfer's 36-character UUID on every chunk and
 * allocated a fresh `TextEncoder` to do it: 45 bytes of overhead and an extra
 * allocation per chunk. A 2-byte session id plus a 2-byte sequence costs 11
 * bytes total and no allocation, and it additionally gives us out-of-order
 * detection, which the UUID version could not.
 */

export const CHUNK_HEADER_BYTES = 11;
export const MAX_CHUNK_PAYLOAD = 0xffff; // u16 length field

export const FLAG_LZ4 = 1 << 0;

export interface DecodedChunk {
  sessionId: number;
  sequence: number;
  payload: Uint8Array;
  isCompressed: boolean;
  crc: number;
}

export class ChunkDecodeError extends Error {
  constructor(
    message: string,
    readonly reason: 'too-short' | 'length-mismatch' | 'bad-flags' | 'not-a-buffer',
  ) {
    super(message);
    this.name = 'ChunkDecodeError';
  }
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, the polynomial zip and PNG use)
//
// Chosen over SHA-256 for the per-chunk integrity check because it is a few
// hundred KB of static table and runs at GB/s, whereas hashing every chunk
// with SubtleCrypto would require an async call per chunk and would dominate
// the transfer. Whole-file SHA-256 still runs once, in a worker, to catch
// misordering that a per-chunk CRC cannot.
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

export function encodeChunk(
  sessionId: number,
  sequence: number,
  payload: Uint8Array,
  isCompressed: boolean,
): ArrayBuffer {
  if (payload.byteLength > MAX_CHUNK_PAYLOAD) {
    throw new RangeError(`chunk payload ${payload.byteLength} exceeds ${MAX_CHUNK_PAYLOAD} bytes`);
  }

  const buffer = new ArrayBuffer(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);

  view.setUint16(0, sessionId & 0xffff, true);
  view.setUint16(2, sequence & 0xffff, true);
  view.setUint32(4, payload.byteLength, true);
  view.setUint8(8, isCompressed ? FLAG_LZ4 : 0);
  // CRC of the payload as it travels, i.e. after compression. The receiver
  // checks it before decompressing, so corruption is caught before it can be
  // fed to the decompressor.
  view.setUint16(9, crc32(payload) & 0xffff, true);

  new Uint8Array(buffer, CHUNK_HEADER_BYTES).set(payload);
  return buffer;
}

export function decodeChunk(input: ArrayBuffer): DecodedChunk {
  if (!(input instanceof ArrayBuffer)) {
    throw new ChunkDecodeError('chunk is not an ArrayBuffer', 'not-a-buffer');
  }
  if (input.byteLength < CHUNK_HEADER_BYTES) {
    // Reachable from a truncated frame or a hostile peer. The previous
    // implementation called `new DataView(buffer).getUint32(0)` with no length
    // check, which threw a RangeError out of a message handler.
    throw new ChunkDecodeError(
      `chunk too short: ${input.byteLength} < ${CHUNK_HEADER_BYTES}`,
      'too-short',
    );
  }

  const view = new DataView(input);
  const sessionId = view.getUint16(0, true);
  const sequence = view.getUint16(2, true);
  const payloadLength = view.getUint32(4, true);
  const flags = view.getUint8(8);
  const crc = view.getUint16(9, true);

  if (payloadLength > MAX_CHUNK_PAYLOAD) {
    throw new ChunkDecodeError(
      `declared payload ${payloadLength} is impossible`,
      'length-mismatch',
    );
  }
  if (CHUNK_HEADER_BYTES + payloadLength !== input.byteLength) {
    throw new ChunkDecodeError(
      `declared payload ${payloadLength} does not match frame size ${input.byteLength}`,
      'length-mismatch',
    );
  }
  if (flags & ~FLAG_LZ4) {
    throw new ChunkDecodeError(`unknown flags 0x${flags.toString(16)}`, 'bad-flags');
  }

  // Copy rather than view: `subarray` aliases the received buffer, and handing
  // an aliased view to a decompressor that retains it is how subtle
  // corruption happens once buffers start being pooled.
  const payload = new Uint8Array(payloadLength);
  payload.set(new Uint8Array(input, CHUNK_HEADER_BYTES, payloadLength));

  return { sessionId, sequence, payload, isCompressed: (flags & FLAG_LZ4) !== 0, crc };
}

/** Verifies a decoded chunk against the CRC carried in its header. */
export function verifyChunk(chunk: DecodedChunk): boolean {
  return (crc32(chunk.payload) & 0xffff) === chunk.crc;
}

// ---------------------------------------------------------------------------
// Out-of-order reassembly
// ---------------------------------------------------------------------------

/**
 * Reorders partially-reliable chunks.
 *
 * The bulk channels use `ordered: false` with `maxRetransmits: 0`, which is
 * what stops one lost packet from stalling an entire transfer. The cost is that
 * chunks can arrive out of order or be dropped, so the receiver reassembles
 * them by sequence and reports gaps rather than writing a corrupt file.
 */
export class Reassembler {
  private next = 0;
  private pending = new Map<number, Uint8Array>();
  /** How long to wait for a gap before giving up on it. */
  private readonly gapTimeoutMs: number;
  private gapSince: number | null = null;

  constructor(gapTimeoutMs = 4000) {
    this.gapTimeoutMs = gapTimeoutMs;
  }

  get expected(): number {
    return this.next;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Adds a chunk and returns everything that is now contiguous.
   *
   * Returns an empty array when the chunk is buffered behind a gap.
   */
  push(sequence: number, payload: Uint8Array, now = Date.now()): Uint8Array[] {
    if (sequence < this.next) return []; // duplicate or already written

    if (sequence === this.next) {
      this.next += 1;
      const out = [payload];
      // Drain anything that was waiting behind this one.
      while (this.pending.has(this.next)) {
        out.push(this.pending.get(this.next)!);
        this.pending.delete(this.next);
        this.next += 1;
      }
      this.gapSince = null;
      return out;
    }

    this.pending.set(sequence, payload);
    if (this.gapSince === null) this.gapSince = now;
    return [];
  }

  /**
   * True when a gap has waited longer than the timeout, which means the chunk
   * is genuinely lost and the transfer cannot be completed.
   */
  isStalled(now = Date.now()): boolean {
    return this.gapSince !== null && now - this.gapSince > this.gapTimeoutMs;
  }

  /** Sequences we are still missing, for diagnostics. */
  missing(): number[] {
    if (this.next > this.pending.size) return [];
    const out: number[] = [];
    for (let i = this.next; i < this.next + this.pending.size + 1; i++) {
      if (!this.pending.has(i)) out.push(i);
    }
    return out;
  }

  reset(): void {
    this.next = 0;
    this.pending.clear();
    this.gapSince = null;
  }
}

// ---------------------------------------------------------------------------
// Content-type sniffing
// ---------------------------------------------------------------------------

/**
 * Extensions that are already compressed.
 *
 * The previous implementation skipped compression purely by extension, so a
 * `.bin` containing compressed data still paid for a full LZ4 pass, and a
 * `.txt` full of random bytes was compressed for nothing. We sample the first
 * chunk instead, which is both faster and correct.
 */
const COMPRESSED_EXTENSIONS = new Set([
  'zip',
  'rar',
  '7z',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'zst',
  'tar',
  'iso',
  'dmg',
  'apk',
  'mp4',
  'mkv',
  'mov',
  'avi',
  'webm',
  'm4v',
  'mpg',
  'mpeg',
  'wmv',
  'flv',
  // NOTE: 'ts' is deliberately absent — MPEG transport stream is compressed,
  // TypeScript source is not. Resolved by MIME type instead.
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'heic',
  'heif',
  'avif',
  'tiff',
  'bmp',
  'mp3',
  'wav',
  'flac',
  'ogg',
  'opus',
  'm4a',
  'aac',
  'wma',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'epub',
  'pdf',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
]);

/**
 * MIME types whose payload is already compressed.
 *
 * Preferred over the file extension because the extension is ambiguous:
 * `.ts` is both a TypeScript source file and an MPEG transport stream, and
 * `.stl` could be either a stereolithography mesh or an H.264 stream. Guessing
 * wrong costs a wasted compression pass on every chunk of a large file.
 */
const COMPRESSED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
const COMPRESSED_MIME_EXACT = new Set([
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-tar',
  'application/zstd',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/pdf',
  'application/epub+zip',
  'application/font-woff',
  'application/font-woff2',
  'font/woff',
  'font/woff2',
]);

export function isKnownCompressed(name: string, mimeType?: string): boolean {
  const mime = mimeType?.toLowerCase().split(';')[0].trim() ?? '';
  if (mime) {
    if (COMPRESSED_MIME_EXACT.has(mime)) return true;
    if (COMPRESSED_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
    // A recognised *incompressible* type: trust it over a misleading extension.
    if (mime.startsWith('text/') || mime === 'application/json') return false;
  }

  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (COMPRESSED_EXTENSIONS.has(ext)) return true;

  // Ambiguous extensions are excluded from the set above and handled here by
  // MIME type alone. `.ts` is TypeScript (compressible) *or* MPEG-TS
  // (already compressed); the caller supplies the browser's answer.
  return false;
}

/**
 * Decides whether compressing this chunk is worth it, from a sample.
 *
 * Below ~3% saving the CPU is not worth it: on a phone, LZ4 on a
 * high-entropy chunk costs real milliseconds of main-thread time for a
 * fraction of a percent of bandwidth.
 */
export function shouldCompressSample(
  name: string,
  originalLength: number,
  compressedLength: number,
  minSavingRatio = 0.03,
  mimeType?: string,
): boolean {
  if (isKnownCompressed(name, mimeType)) return false;
  if (originalLength === 0) return false;
  return compressedLength < originalLength * (1 - minSavingRatio);
}
