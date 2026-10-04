# Architecture

AirDelivery is two things: a signaling server, and a pair of browsers that talk
to each other directly. Almost every design decision follows from keeping those
two responsibilities strictly separate.

```
┌─────────────────────────┐          ┌─────────────────────────┐
│      browser (sender)   │          │   browser (receiver)    │
│                         │          │                         │
│  useWebRTC ── session   │          │  useWebRTC ── session   │
│  useFileTransfer ── io  │          │  useFileTransfer ── io  │
│  codec / hash / sink    │          │  codec / hash / sink    │
└───────────┬─────────────┘          └─────────────┬────────────┘
            │  SDP offer/answer + ICE candidates    │
            └──────────────► signaling ◄────────────┘
                            (validates, authorizes,
                             routes, expires)
                                    │
                            ┌───────┴────────┐
                            │ FlightManager  │ in-memory, TTL'd
                            │ UserManager    │ bucketed by network
                            │ StatManager    │ buffered counters
                            └────────────────┘

            file chunks travel directly between the browsers,
            bypassing the signaling server entirely
```

## Packages

### `@airdelivery/protocol`

One schema per message, imported by both sides. This is the trust boundary: an
untrusted browser is the only thing on the other end of every socket frame, so
every payload is validated with an explicit size cap before it can be logged,
stored or forwarded.

Adding an event means adding a schema here. The two sides cannot then drift,
which is how `requestToConnect` came to be fully implemented on the server while
no client had ever heard of the `flightStarted` event it emitted.

### `@airdelivery/backend`

Node + Express + Socket.IO. Holds no file data.

| Module                     | Responsibility                                                                    |
| -------------------------- | --------------------------------------------------------------------------------- |
| `config/`                  | Validate every env var once, at startup, and refuse to boot on a misconfiguration |
| `socket/guard.ts`          | Isolate listener exceptions; install process guards; bound work per socket        |
| `socket/handlers.ts`       | Validate, authorize and route every event                                         |
| `services/FlightManager`   | Flight lifecycle: creation, idempotent joins, departures, TTL                     |
| `services/UserManager`     | Per-connection registry, bucketed by network prefix for discovery                 |
| `services/StatManager`     | Buffered aggregate counters, flushed on an interval                               |
| `services/clientConfig.ts` | ICE servers and transfer tuning served to clients                                 |
| `utils/net.ts`             | CIDR-based address classification                                                 |

Three invariants hold everywhere:

1. **Nothing throws out of a listener.** A malformed packet costs that client
   their transfer, never the service.
2. **Every event is authorized.** Membership is proven, mutations check
   ownership, and no payload is trusted before it is validated.
3. **Nothing lives forever.** Flights expire, buffered counters are bounded,
   socket state is released on disconnect.

### `@airdelivery/frontend`

Next.js App Router. Two hooks carry the weight.

**`useWebRTC`** owns the peer connection. It implements the
[perfect negotiation](https://w3c.github.io/webrtc-pc/#perfect-negotiation-example)
pattern so offer glare resolves deterministically instead of dead-ending. It
performs real ICE restarts with renegotiation — `restartIce()` on its own is a
no-op — and exposes connection state as data the UI can render.

**`useFileTransfer`** owns the transfer. Its job is to keep memory bounded on
both sides while keeping the pipe full:

- The send loop fills the channel to a high-water mark, then yields via
  `scheduler.yield()` or a `MessageChannel` round trip. Never `setTimeout`, which
  browsers clamp and which caps throughput around 16 MB/s.
- Bulk channels are partially reliable and unordered; the receiver reassembles
  by sequence and reports a genuine loss as a stall. The control channel stays
  reliable and ordered.
- The receive queue has a high-water mark that pauses the sender and a hard
  limit that drops rather than grows.
- Received bytes stream to OPFS, a chosen folder, or a blob — in that order —
  so a multi-gigabyte file never needs to be resident.

Supporting modules are deliberately pure and separately testable:

| Module                     | Why it is separate                                 |
| -------------------------- | -------------------------------------------------- |
| `lib/transfer/codec.ts`    | Fixed-width binary framing and sequence reassembly |
| `lib/transfer/hash.ts`     | Incremental SHA-256, verified against NIST vectors |
| `lib/transfer/yield.ts`    | Cooperative yielding strategies                    |
| `lib/storage/sink.ts`      | Receive storage ladder and capability detection    |
| `utils/flattenFilelist.ts` | Folder traversal and path sanitisation             |

## Data flow of one transfer

1. The sender emits `createFlight`; the server returns a six-character code.
2. The joiner emits `joinFlight`. The server validates the code, records
   membership and joins the socket room.
3. Both sides receive authoritative `flightUsers`. The owner is determined by
   `ownerId`; the joiner learns the owner's socket id from `flightStarted`.
4. The owner opens parallel bulk channels plus one control channel, and emits an
   offer. ICE candidates trickle in both directions.
5. The joiner answers; the channels open.
6. The sender emits a `begin` control message with the path, size and digest,
   then streams `encodeChunk`ed chunks.
7. The receiver decodes, verifies the per-chunk CRC, decompresses if flagged,
   reassembles by sequence, hashes, and writes to its sink.
8. On completion the receiver compares its whole-file digest against the sender's
   and releases the file.

## Deliberate non-goals

- **No accounts, no storage, no history on the server.** The pitch is that we do
  not keep your data; anything that needed a server-side record would undercut it.
- **No server-mediated fallback transfer.** It would work more often and would
  make the privacy claim untrue.
- **More than two peers per flight.** Every additional peer changes the
  negotiation model from one offer to a mesh, which is a different product.
