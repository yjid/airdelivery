# 2. Bulk data channels are partially reliable

Date: 2025

## Status

Accepted

## Context

WebRTC data channels default to `ordered: true` with full retransmission. That
gives at-most-once, in-order delivery, which sounds ideal and is not.

On a lossy link — a phone on cellular, a campus Wi-Fi with interference — a
single lost packet blocks every subsequent packet on the channel until the
retransmission arrives. The transfer appears to freeze for a second and then
resumes, and on a bad link this happens constantly. The effect is throughput far
below what the link can carry.

A CRC or hash cannot help: a lost chunk stalls the stream before any integrity
check would run.

## Decision

Open several parallel bulk channels with `ordered: false` and a low
`maxRetransmits`, and keep one reliable ordered control channel for JSON
messages. The receiver reassembles by sequence number and reports a genuine gap
as a stall.

Control messages must never be reordered or lost, so that channel stays reliable.
Chunk loss is recoverable; a lost `begin` or `done` is not.

## Consequences

- The codec carries a sequence number, so out-of-order delivery is detectable.
  This is also what lets the whole-file hash catch reordering.
- A genuinely lost chunk now fails the transfer instead of stalling it. The
  reassembler's gap timeout turns that into a clear error.
- Parallel channels mean loss on one does not stall the others.
- The sender needs reassembly-aware progress reporting, which is slightly more
  complex than "bytes written".

## Alternatives considered

- **Fully reliable, ordered** — simpler, and what the code did before. Measurably
  worse on lossy links, which is most mobile use.
- **WebTransport** — congestion control per stream and no STUN/TURN dependency.
  Not yet available outside Chromium, so it cannot be the only path.
