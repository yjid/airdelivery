# @airdelivery/frontend

The AirDelivery client. Next.js App Router.

```bash
bun run dev        # turbopack dev server
bun test           # 84 tests
bun run typecheck
bun run build
```

## Layout

| Path                        | Responsibility                                     |
| --------------------------- | -------------------------------------------------- |
| `app/`                      | Routes. Home, flight room, guide, offline          |
| `hooks/useWebRTC.ts`        | Peer connection, perfect negotiation, ICE restart  |
| `hooks/useFileTransfer.ts`  | Send and receive loops, backpressure, cancellation |
| `lib/transfer/codec.ts`     | Binary framing and sequence reassembly             |
| `lib/transfer/hash.ts`      | Incremental SHA-256                                |
| `lib/transfer/yield.ts`     | Cooperative yielding                               |
| `lib/storage/sink.ts`       | Receive storage ladder and capability detection    |
| `context/socketContext.tsx` | Connection lifecycle, reconnect, ICE config        |
| `context/WebRTCContext.tsx` | State and actions for the app                      |

## Rules for changes in here

**Keep the hot path allocation-free.** The transfer loop runs thousands of times
per second. Reuse buffers and hoist encoders.

**Never yield with `setTimeout`.** Browsers clamp nested timers to ~4 ms, which
caps throughput near 16 MB/s. Use `yieldToEventLoop()` from `lib/transfer/yield`.

**Any new socket message needs a schema in `@airdelivery/protocol`.** Local
validation is how the two sides drift apart.

**Receiving must stay memory-bounded.** The receive queue has a high-water mark
that pauses the sender. Do not remove it.

`reactStrictMode` is enabled deliberately. If an effect needs a double-invocation
guard, that is the bug being surfaced — fix the cleanup rather than the guard.
