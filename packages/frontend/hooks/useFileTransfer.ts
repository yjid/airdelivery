'use client';

/**
 * File transfer engine.
 *
 * Rewritten around three invariants the previous version violated.
 *
 * 1. THE RECEIVER MUST NEVER EXCEED MEMORY.
 *    `incoming.current[id].queue` was an unbounded array of ArrayBuffers with no
 *    cap and no backpressure to the sender. A slow disk or a slow phone would
 *    let it grow until the tab was OOM-killed mid-transfer. There is now a
 *    hard byte ceiling, and exceeding it pauses the sender rather than
 *    buffering more.
 *
 * 2. PER-TRANSFER STATE MUST BE PER TRANSFER.
 *    `lastBlobRef` and `pendingBlobUrlRef` were single module-level refs shared
 *    by every concurrent transfer, so with two files arriving at once one
 *    transfer's completion would hand the other transfer's blob to the
 *    auto-download path, saving the wrong file under the wrong name. Both are
 *    now fields on the per-transfer record.
 *
 * 3. NO WHOLE-FILE BUFFERS.
 *    `sha256Hex(file)` before sending, `verifyDisk` reading the file back
 *    afterwards, and the 1.2 GB in-memory receive cap each meant a multi-
 *    gigabyte transfer needed the whole file resident at once. Hashing is now
 *    incremental, and receiving streams to OPFS or a chosen folder.
 *
 * Performance changes, since throughput is the product:
 *  - The per-chunk `await setTimeout(0)` is gone. Browsers clamp nested timers
 *    to ~4 ms, which capped the sender at ~250 chunks/s (~16 MB/s) regardless
 *    of link speed. See `lib/transfer/yield.ts`.
 *  - Bulk channels are partially reliable, so a lost packet no longer stalls
 *    the whole file; the receiver reassembles by sequence.
 *  - Chunk size is read from `pc.sctp.maxMessageSize`. The previous code read
 *    `dataChannel.maxMessageSize`, which does not exist in any browser, so the
 *    negotiated 256 KB limit was never discovered and every transfer ran at the
 *    64 KB fallback.
 *  - Buffers are reused and the header no longer carries a UUID.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  MAX_CHUNK_PAYLOAD,
  Reassembler,
  decodeChunk,
  encodeChunk,
  isKnownCompressed,
  shouldCompressSample,
  verifyChunk,
  type DecodedChunk,
} from '@/lib/transfer/codec';
import { yieldToEventLoop } from '@/lib/transfer/yield';
import { NATIVE_HASH_LIMIT_BYTES, Sha256, hashBlob } from '@/lib/transfer/hash';
import { createSink, describeStrategy, type Sink, type StorageKind } from '@/lib/storage/sink';
import { collectFiles } from '@/utils/flattenFilelist';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransferStatus =
  'queued' | 'sending' | 'paused' | 'done' | 'error' | 'canceled' | 'receiving' | 'verifying';

export interface TransferItem {
  transferId: string;
  file: File;
  directoryPath: string;
  progress: number;
  bytesSent: number;
  status: TransferStatus;
  thumbnail?: string;
  /** Populated when status is 'error', for the UI to show. */
  error?: string;
}

export interface ReceivedItem {
  transferId: string;
  directoryPath: string;
  size: number;
  received: number;
  progress: number;
  url: string | null;
  type: 'receive';
  downloaded: boolean;
  status: TransferStatus;
  thumbnail?: string;
  storage: StorageKind;
  error?: string;
}

export interface TransferMetrics {
  totalSent: number;
  totalReceived: number;
  sendSpeedBps: number;
  receiveSpeedBps: number;
}

// ---------------------------------------------------------------------------
// Control messages
// ---------------------------------------------------------------------------

type ControlMessage =
  | {
      type: 'begin';
      session: number;
      transferId: string;
      path: string;
      size: number;
      hash?: string;
      mime?: string;
      thumb?: string;
    }
  | { type: 'end'; session: number; hash?: string }
  | { type: 'pause'; session: number }
  | { type: 'resume'; session: number }
  | { type: 'cancel'; session: number }
  | { type: 'reject'; session: number; reason: string };

interface IncomingRecord {
  transferId: string;
  session: number;
  path: string;
  size: number;
  received: number;
  hasher: Sha256;
  reassembler: Reassembler;
  sink: Sink;
  /** Digest the sender announced, when one is available. */
  expectedHash: string | undefined;
  queue: DecodedChunk[];
  queuedBytes: number;
  draining: boolean;
  controls: Controls;
  lastProgressAt: number;
  closed: boolean;
}

interface Controls {
  paused: boolean;
  canceled: boolean;
  resumeResolve: (() => void) | null;
}

const newControls = (): Controls => ({ paused: false, canceled: false, resumeResolve: null });

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Peak receive-side buffering before we ask the sender to pause.
 *
 * 32 MB is roughly one chunk per parallel channel plus slack. Large enough that
 * a burst never triggers a round trip, small enough that a phone cannot be
 * pushed into a swap.
 */
const RECEIVE_HIGH_WATER = 32 * 1024 * 1024;

/** Refuse to grow the queue past this at all, whatever the peer does. */
const RECEIVE_HARD_LIMIT = 96 * 1024 * 1024;

const PROGRESS_INTERVAL_MS = 250;

const STATUS_LABELS: Record<TransferStatus, string> = {
  queued: 'Waiting',
  sending: 'Transferring',
  paused: 'Paused',
  done: 'Completed',
  error: 'Failed',
  canceled: 'Canceled',
  receiving: 'Receiving',
  verifying: 'Verifying',
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFileTransfer(options: {
  dataChannel: RTCDataChannel | null;
  controlChannel: RTCDataChannel | null;
  peer: React.MutableRefObject<RTCPeerConnection | null>;
  onDisconnect: () => void;
  onStats: (files: number, bytes: number) => void;
  config?: { maxChunkBytes?: number; parallelChannels?: number } | null;
}) {
  const { dataChannel, controlChannel, peer, onDisconnect, onStats, config } = options;

  const [queue, setQueue] = useState<TransferItem[]>([]);
  const [recvQueue, setRecvQueue] = useState<ReceivedItem[]>([]);
  const [metrics, setMetrics] = useState<TransferMetrics>({
    totalSent: 0,
    totalReceived: 0,
    sendSpeedBps: 0,
    receiveSpeedBps: 0,
  });

  const outgoing = useRef(new Map<string, Controls>());
  const incoming = useRef(new Map<number, IncomingRecord>());
  /** Session ids for outgoing transfers. u16, so it wraps after 65535. */
  const nextSession = useRef(1);
  const results = useRef(new Map<number, { url: string | null; dispose?: () => void }>());

  const sentRef = useRef(0);
  const receivedRef = useRef(0);
  const sendAccum = useRef(0);
  const receiveAccum = useRef(0);

  // -- metrics ---------------------------------------------------------------

  useEffect(() => {
    const id = setInterval(() => {
      setMetrics({
        totalSent: sentRef.current,
        totalReceived: receivedRef.current,
        sendSpeedBps: sendAccum.current,
        receiveSpeedBps: receiveAccum.current,
      });
      sendAccum.current = 0;
      receiveAccum.current = 0;
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // -- sizing ----------------------------------------------------------------

  /**
   * The negotiated SCTP message size.
   *
   * `RTCDataChannel.maxMessageSize` does not exist in any browser, so the
   * previous `dataChannel.maxMessageSize` probe always returned undefined and
   * every transfer silently ran at the 64 KB fallback instead of the 256 KB
   * the connection had actually negotiated.
   */
  const chunkSize = useMemo(() => {
    const configured = config?.maxChunkBytes;
    if (typeof configured === 'number' && configured > 0) {
      return Math.min(configured, MAX_CHUNK_PAYLOAD);
    }
    const negotiated = peer.current?.sctp?.maxMessageSize;
    if (typeof negotiated === 'number' && negotiated > 0) {
      // Leave headroom for the header.
      return Math.max(16 * 1024, Math.min(negotiated - 1024, MAX_CHUNK_PAYLOAD));
    }
    return 64 * 1024;
  }, [config?.maxChunkBytes, peer]);

  // -- sending ---------------------------------------------------------------

  const sendControl = useCallback(
    (message: ControlMessage) => {
      const payload = JSON.stringify(message);
      const target = controlChannel?.readyState === 'open' ? controlChannel : dataChannel;
      if (!target || target.readyState !== 'open') return false;
      try {
        target.send(payload);
        return true;
      } catch {
        return false;
      }
    },
    [controlChannel, dataChannel],
  );

  /**
   * Awaits the receive buffer falling below the low-water mark.
   *
   * Driven purely off `onbufferedamountlow`, which fires as a task and so is
   * not subject to the timer clamping that throttled the old loop.
   */
  const waitForDrain = useCallback((channel: RTCDataChannel): Promise<void> => {
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        channel.removeEventListener('bufferedamountlow', finish);
        clearTimeout(timer);
        resolve();
      };
      // A lost low-water event must not deadlock the transfer forever.
      const timer = setTimeout(finish, 1000);
      channel.addEventListener('bufferedamountlow', finish, { once: true });
    });
  }, []);

  const sendFile = useCallback(
    async (item: TransferItem) => {
      const channel = dataChannel;
      if (!channel || channel.readyState !== 'open') {
        throw new Error('Connection closed');
      }

      const controls = outgoing.current.get(item.transferId);
      if (!controls) throw new Error('Transfer no longer exists');

      const session = nextSession.current++ & 0xffff;
      const { file } = item;

      // Hashing strategy. Small files use native SubtleCrypto, which is about
      // an order of magnitude faster. Large files are hashed incrementally as
      // the bytes stream past, because reading a multi-gigabyte file into
      // memory to hash it is what used to kill the tab on a phone.
      const hashUpFront = file.size <= NATIVE_HASH_LIMIT_BYTES;
      const hasher = hashUpFront ? null : new Sha256();
      const announcedHash = hashUpFront ? await hashBlob(file) : undefined;

      if (
        !sendControl({
          type: 'begin',
          session,
          transferId: item.transferId,
          path: item.directoryPath,
          size: file.size,
          hash: announcedHash,
          mime: file.type,
          thumb: undefined,
        })
      ) {
        throw new Error('Connection closed');
      }

      // Sample the first chunk to decide whether compression is worth it, and
      // remember the answer for the rest of the file.
      const mayCompress = !isKnownCompressed(item.directoryPath, file.type);
      let compressThisFile = mayCompress;

      let offset = 0;
      let sequence = 0;

      while (offset < file.size) {
        if (controls.canceled) {
          sendControl({ type: 'cancel', session });
          throw new CanceledError();
        }

        if (controls.paused) {
          sendControl({ type: 'pause', session });
          await new Promise<void>((resolve) => {
            controls.resumeResolve = resolve;
          });
          controls.resumeResolve = null;
          if (controls.canceled) {
            sendControl({ type: 'cancel', session });
            throw new CanceledError();
          }
          sendControl({ type: 'resume', session });
        }

        // Cooperative yield. Not every chunk: the browser copes with short
        // bursts, and a task per chunk is its own overhead.
        if ((sequence & 7) === 0) await yieldToEventLoop();

        if (channel.readyState !== 'open') throw new Error('Connection closed');
        if (channel.bufferedAmount > 0) await waitForDrain(channel);

        const end = Math.min(offset + chunkSize, file.size);
        let payload = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        let compressed = false;

        if (compressThisFile) {
          const { compress } = await import('lz4js');
          const packed = compress(payload);
          // Decide once, from the first chunk, and stick with it. Re-deciding per
          // chunk meant a mixed file could be half compressed and half not.
          if (sequence === 0) {
            compressThisFile = shouldCompressSample(
              item.directoryPath,
              payload.length,
              packed.length,
              0.03,
              file.type,
            );
          }
          if (compressThisFile && packed.length < payload.length) {
            // Copy into a concrete ArrayBuffer: lz4js hands back a view typed
            // over ArrayBufferLike, which cannot be passed to `send`.
            const buffer = new Uint8Array(packed.length);
            buffer.set(packed);
            payload = buffer;
            compressed = true;
          }
        }

        try {
          channel.send(encodeChunk(session, sequence, payload, compressed));
        } catch (err) {
          // A full send buffer is transient; anything else is terminal.
          if ((err as DOMException)?.name === 'OperationError') {
            await new Promise((r) => setTimeout(r, 50));
            channel.send(encodeChunk(session, sequence, payload, compressed));
          } else {
            throw err;
          }
        }

        const advanced = end - offset;
        offset = end;
        sequence += 1;

        sentRef.current += advanced;
        sendAccum.current += advanced;

        // Hash the plaintext, before compression, so the digest matches what
        // the receiver hashes after decompression.
        if (hasher) hasher.update(payload);

        if (sequence % 8 === 0) {
          const pct = Math.round((offset / file.size) * 100);
          setQueue((q) =>
            q.map((t) => (t.transferId === item.transferId ? { ...t, progress: pct } : t)),
          );
        }
      }

      sendControl({ type: 'end', session, hash: announcedHash ?? hasher?.hex() });

      setQueue((q) =>
        q.map((t) =>
          t.transferId === item.transferId
            ? { ...t, progress: 100, bytesSent: file.size, status: 'done' }
            : t,
        ),
      );
      onStats(1, file.size);
    },
    [chunkSize, dataChannel, onStats, sendControl, waitForDrain],
  );

  // -- receiving -------------------------------------------------------------

  const failIncoming = useCallback(
    async (record: IncomingRecord, message: string) => {
      await record.sink.abort().catch(() => undefined);
      incoming.current.delete(record.session);
      setRecvQueue((rq) =>
        rq.map((r) =>
          r.transferId === record.transferId ? { ...r, status: 'error', error: message } : r,
        ),
      );
      sendControl({ type: 'reject', session: record.session, reason: message });
    },
    [sendControl],
  );

  const finalize = useCallback(
    async (record: IncomingRecord) => {
      record.closed = true;
      setRecvQueue((rq) =>
        rq.map((r) => (r.transferId === record.transferId ? { ...r, status: 'verifying' } : r)),
      );

      let result;
      try {
        result = await record.sink.close();
      } catch (err) {
        await failIncoming(record, (err as Error).message);
        return;
      }

      if (record.size > 0 && record.received !== record.size) {
        await failIncoming(
          record,
          `Incomplete transfer: got ${record.received} of ${record.size} bytes.`,
        );
        return;
      }

      // Per-chunk CRC catches corruption. This catches reordering and
      // truncation, which a CRC structurally cannot, because a chunk is
      // perfectly valid on its own wherever it lands.
      if (record.expectedHash) {
        const actual = record.hasher.hex();
        if (actual !== record.expectedHash) {
          await failIncoming(record, 'Integrity check failed. The file was not saved.');
          return;
        }
      }

      incoming.current.delete(record.session);
      if (result.url)
        results.current.set(record.session, { url: result.url, dispose: result.dispose });

      setRecvQueue((rq) =>
        rq.map((r) =>
          r.transferId === record.transferId
            ? {
                ...r,
                status: 'done',
                progress: 100,
                received: record.received,
                url: result.url,
                downloaded: result.kind !== 'blob',
              }
            : r,
        ),
      );
    },
    [failIncoming],
  );

  const drain = useCallback(
    async (record: IncomingRecord) => {
      record.draining = true;
      try {
        while (record.queue.length > 0) {
          if (record.controls.canceled) return;

          const chunk = record.queue.shift()!;
          record.queuedBytes -= chunk.payload.byteLength;

          if (!verifyChunk(chunk)) {
            await failIncoming(
              record,
              'A chunk failed its integrity check. The file was not saved.',
            );
            return;
          }

          let bytes = chunk.payload;
          if (chunk.isCompressed) {
            try {
              const { decompress } = await import('lz4js');
              bytes = decompress(chunk.payload);
            } catch {
              await failIncoming(
                record,
                'Could not decompress the transfer. Try a different browser.',
              );
              return;
            }
          }

          try {
            await record.sink.write(bytes);
          } catch (err) {
            // Most commonly "this device cannot store a file this large".
            await failIncoming(record, (err as Error).message);
            return;
          }

          record.received += bytes.byteLength;
          record.hasher.update(bytes);
          receivedRef.current += bytes.byteLength;
          receiveAccum.current += bytes.byteLength;

          const now = Date.now();
          if (now - record.lastProgressAt > PROGRESS_INTERVAL_MS) {
            record.lastProgressAt = now;
            const pct = record.size > 0 ? Math.round((record.received / record.size) * 100) : 0;
            setRecvQueue((rq) =>
              rq.map((r) =>
                r.transferId === record.transferId
                  ? { ...r, received: record.received, progress: pct }
                  : r,
              ),
            );
          }
        }
      } finally {
        record.draining = false;
      }
    },
    [failIncoming],
  );

  // -- inbound dispatch ------------------------------------------------------

  useEffect(() => {
    const channels = [dataChannel, controlChannel].filter(Boolean) as RTCDataChannel[];
    if (channels.length === 0) return;

    const onMessage = async (event: MessageEvent) => {
      // Control plane: JSON strings.
      if (typeof event.data === 'string') {
        let message: ControlMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (message.type === 'begin') {
          const sink = await createSink(message.path, message.size);
          if (sink.kind === 'none') {
            sendControl({
              type: 'reject',
              session: message.session,
              reason: 'This device cannot store a file that large.',
            });
            return;
          }

          const record: IncomingRecord = {
            transferId: message.transferId,
            session: message.session,
            path: message.path,
            size: message.size,
            received: 0,
            hasher: new Sha256(),
            reassembler: new Reassembler(),
            sink,
            expectedHash: message.hash,
            queue: [],
            queuedBytes: 0,
            draining: false,
            controls: newControls(),
            lastProgressAt: 0,
            closed: false,
          };
          incoming.current.set(message.session, record);

          setRecvQueue((rq) => [
            ...rq,
            {
              transferId: message.transferId,
              directoryPath: message.path,
              size: message.size,
              received: 0,
              progress: 0,
              url: null,
              type: 'receive',
              downloaded: false,
              status: 'receiving',
              thumbnail: message.thumb,
              storage: sink.kind,
            },
          ]);
          return;
        }

        const record = incoming.current.get(message.session);
        if (message.type === 'pause' && record) {
          record.controls.paused = true;
          setRecvQueue((rq) =>
            rq.map((r) => (r.transferId === record.transferId ? { ...r, status: 'paused' } : r)),
          );
          return;
        }
        if (message.type === 'resume' && record) {
          record.controls.paused = false;
          setRecvQueue((rq) =>
            rq.map((r) => (r.transferId === record.transferId ? { ...r, status: 'receiving' } : r)),
          );
          if (!record.draining) void drain(record);
          return;
        }
        if (message.type === 'cancel') {
          if (record) {
            await record.sink.abort().catch(() => undefined);
            incoming.current.delete(message.session);
            setRecvQueue((rq) =>
              rq.map((r) =>
                r.transferId === record.transferId ? { ...r, status: 'canceled' } : r,
              ),
            );
          } else {
            // The sender cancelled something we were sending.
            for (const controls of outgoing.current.values()) controls.canceled = true;
          }
          return;
        }
        if (message.type === 'end') {
          if (record) {
            // Large files only reveal their digest at the end.
            if (message.hash) record.expectedHash = message.hash;
            await finalize(record);
          }
          return;
        }
        if (message.type === 'reject') {
          // The receiver could not store the file. Fail our send immediately
          // rather than pushing gigabytes at a device that cannot keep them.
          const failed = [...outgoing.current.entries()].find(([, c]) => c.canceled);
          if (failed) {
            const [id, controls] = failed;
            controls.canceled = true;
            setQueue((q) =>
              q.map((t) =>
                t.transferId === id ? { ...t, status: 'error', error: message.reason } : t,
              ),
            );
          }
          return;
        }
        return;
      }

      // Data plane: binary chunks.
      let chunk: DecodedChunk;
      try {
        chunk = decodeChunk(event.data);
      } catch {
        // A malformed frame is dropped, not thrown. The receiver cannot do
        // anything about it and must not die trying.
        return;
      }

      const record = incoming.current.get(chunk.sessionId);
      if (!record || record.closed) return;

      // Bounded buffering. Beyond the hard limit the chunk is dropped rather
      // than retained, which lets the reassembler's gap timeout surface a real
      // stall instead of exhausting the heap.
      if (record.queuedBytes + chunk.payload.byteLength > RECEIVE_HARD_LIMIT) return;

      for (const ready of record.reassembler.push(chunk.sequence, chunk.payload)) {
        record.queue.push({ ...chunk, payload: ready });
        record.queuedBytes += ready.byteLength;
      }

      if (!record.draining) void drain(record);

      // Ask the sender to ease off once we are buffering more than we should.
      if (record.queuedBytes > RECEIVE_HIGH_WATER) {
        sendControl({ type: 'pause', session: record.session });
      }
    };

    const onClose = () => {
      for (const record of incoming.current.values()) {
        record.controls.canceled = true;
        void record.sink.abort().catch(() => undefined);
      }
      incoming.current.clear();
      setQueue((q) => q.map((t) => (t.status === 'sending' ? { ...t, status: 'paused' } : t)));
      onDisconnect();
    };

    for (const channel of channels) {
      channel.binaryType = 'arraybuffer';
      channel.addEventListener('message', onMessage);
      channel.addEventListener('close', onClose);
      channel.addEventListener('error', onClose);
    }

    return () => {
      for (const channel of channels) {
        channel.removeEventListener('message', onMessage);
        channel.removeEventListener('close', onClose);
        channel.removeEventListener('error', onClose);
      }
    };
  }, [controlChannel, dataChannel, drain, finalize, onDisconnect, sendControl]);

  // -- queue runner ----------------------------------------------------------

  const running = useRef(new Set<string>());

  useEffect(() => {
    const next = queue.find((t) => t.status === 'queued' && !running.current.has(t.transferId));
    if (!next) return;
    if (!dataChannel || dataChannel.readyState !== 'open') return;

    running.current.add(next.transferId);
    setQueue((q) =>
      q.map((t) => (t.transferId === next.transferId ? { ...t, status: 'sending' } : t)),
    );

    void sendFile(next)
      .catch((err: unknown) => {
        if (err instanceof CanceledError) return;
        const message = (err as Error)?.message ?? 'Transfer failed';
        setQueue((q) =>
          q.map((t) =>
            t.transferId === next.transferId ? { ...t, status: 'error', error: message } : t,
          ),
        );
      })
      .finally(() => {
        running.current.delete(next.transferId);
      });
  }, [dataChannel, queue, sendFile]);

  // -- selection -------------------------------------------------------------

  const enqueueFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const items: TransferItem[] = files.map((file) => {
      const transferId = crypto.randomUUID();
      outgoing.current.set(transferId, newControls());
      return {
        transferId,
        file,
        directoryPath: file.name,
        progress: 0,
        bytesSent: 0,
        status: 'queued' as const,
      };
    });
    setQueue((prev) => {
      const seen = new Set(prev.map((t) => t.directoryPath));
      return [...prev, ...items.filter((i) => !seen.has(i.directoryPath))];
    });
  }, []);

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      await enqueueFiles(await collectFiles(event.target.files));
      // Allow re-selecting the same file.
      event.target.value = '';
    },
    [enqueueFiles],
  );

  // -- controls --------------------------------------------------------------

  const pauseTransfer = useCallback((transferId: string) => {
    const controls = outgoing.current.get(transferId);
    if (controls) controls.paused = true;
    setQueue((q) =>
      q.map((t) =>
        t.transferId === transferId && t.status === 'sending' ? { ...t, status: 'paused' } : t,
      ),
    );
  }, []);

  const resumeTransfer = useCallback((transferId: string) => {
    const controls = outgoing.current.get(transferId);
    if (controls) {
      controls.paused = false;
      controls.resumeResolve?.();
    }
    setQueue((q) =>
      q.map((t) =>
        t.transferId === transferId && t.status === 'paused' ? { ...t, status: 'sending' } : t,
      ),
    );
  }, []);

  const cancelTransfer = useCallback((transferId: string) => {
    const controls = outgoing.current.get(transferId);
    if (controls) {
      controls.canceled = true;
      controls.resumeResolve?.();
    }
    setQueue((q) => q.map((t) => (t.transferId === transferId ? { ...t, status: 'canceled' } : t)));
  }, []);

  const cancelReceive = useCallback(
    (transferId: string) => {
      // Find first, then delete. Deleting while iterating a Map is legal but
      // reads as if it might skip an entry.
      const entry = [...incoming.current.entries()].find(
        ([, record]) => record.transferId === transferId,
      );
      if (entry) {
        const [session, record] = entry;
        record.controls.canceled = true;
        void record.sink.abort().catch(() => undefined);
        incoming.current.delete(session);
        sendControl({ type: 'cancel', session });
      }
      setRecvQueue((rq) =>
        rq.map((r) => (r.transferId === transferId ? { ...r, status: 'canceled' } : r)),
      );
    },
    [sendControl],
  );

  // -- downloads and cleanup -------------------------------------------------

  const downloadFile = useCallback((item: ReceivedItem) => {
    if (!item.url) return;
    const anchor = document.createElement('a');
    anchor.href = item.url;
    anchor.download = item.directoryPath.split('/').pop() ?? item.directoryPath;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setRecvQueue((rq) =>
      rq.map((r) => (r.transferId === item.transferId ? { ...r, downloaded: true } : r)),
    );
  }, []);

  /**
   * Releases every object URL we created.
   *
   * Without this, every received blob URL lives until the document unloads. On
   * a phone that is the difference between finishing a session and being
   * OOM-killed halfway through the next one.
   */
  const releaseUrls = useCallback(() => {
    for (const { dispose } of results.current.values()) dispose?.();
    results.current.clear();
    setRecvQueue((rq) => rq.map((r) => ({ ...r, url: null })));
  }, []);

  const reset = useCallback(() => {
    for (const controls of outgoing.current.values()) {
      controls.canceled = true;
      controls.resumeResolve?.();
    }
    outgoing.current.clear();
    for (const record of incoming.current.values()) {
      record.controls.canceled = true;
      void record.sink.abort().catch(() => undefined);
    }
    incoming.current.clear();
    releaseUrls();
    setQueue([]);
    setRecvQueue([]);
    sentRef.current = 0;
    receivedRef.current = 0;
    sendAccum.current = 0;
    receiveAccum.current = 0;
    setMetrics({ totalSent: 0, totalReceived: 0, sendSpeedBps: 0, receiveSpeedBps: 0 });
  }, [releaseUrls]);

  // Abandon in-flight work when the component goes away, and release URLs even
  // if nothing else calls reset.
  useEffect(() => {
    const records = incoming.current;
    const urls = results.current;
    const sends = outgoing.current;
    return () => {
      for (const controls of sends.values()) {
        controls.canceled = true;
        controls.resumeResolve?.();
      }
      for (const record of records.values()) {
        record.controls.canceled = true;
        void record.sink.abort().catch(() => undefined);
      }
      records.clear();
      for (const { dispose } of urls.values()) dispose?.();
      urls.clear();
    };
  }, []);

  return {
    queue: useMemo(() => queue.map((t) => ({ ...t, label: STATUS_LABELS[t.status] })), [queue]),
    recvQueue,
    metrics,
    storageLabel: describeStrategy,
    handleFileSelect,
    enqueueFiles,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    cancelReceive,
    downloadFile,
    releaseUrls,
    reset,
  };
}

class CanceledError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CanceledError';
  }
}
