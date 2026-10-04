# Roadmap

Roughly ordered by value. Nothing here is committed to a date, and the order
changes as we learn what people actually need.

## Done

- Signaling server that survives malformed traffic instead of restarting
- Correct flight lifecycle: no more hanging when the other side disconnects
- Idempotent joins, so refreshing your own link no longer ejects you
- Every socket payload validated and authorized
- TURN configuration, environment-driven
- Streaming receive to disk via OPFS, so large files do not OOM a phone
- Incremental SHA-256 verification with no whole-file reads
- Real ICE restart with renegotiation
- Perfect negotiation, so glare no longer dead-ends
- Folder selection that does not silently drop files past 100 entries
- Working home-page send flow
- Error boundaries, so a crash is recoverable
- 262 tests, and lint/typecheck/build that pass on a clean checkout

## Next

- **Playwright end-to-end suite** covering the four network scenarios. Needs
  device emulation and a NAT-blocked simulation. Highest-value gap.
- **Resumable transfers.** Persist the offset and hash state so a transfer
  survives a reload, a backgrounded phone, or a dropped connection. Every
  comparable tool has this and we do not.
- **Compression in a worker.** LZ4 currently runs on the main thread, which
  costs real milliseconds per chunk on a phone.
- **Load testing** to find the actual concurrent-connection ceiling.
- **Codable compressed streams** for the control channel, removing JSON overhead.

## Later

- **WebTransport**, for connections that do not need STUN or TURN at all.
  Chrome-only today, so it would be additive rather than a replacement.
- **Native shells** via TWA or Capacitor. The phone cases matter a great deal.
- **Plugin point for codecs**, so third parties can add compression without a
  core change.
- **More than two peers per flight**, which means a mesh negotiation model.
- **Translations.** The strings are already centralised enough.

## Explicitly not planned

- Server-side file storage, in any form
- Accounts, profiles, or persistent user identity
- A server-mediated transfer fallback. It would work more often, and it would
  make the privacy claim untrue.

## Want to help?

Issues labelled
[`good first issue`](https://github.com/GochiStuff/airdelivery/labels/good%20first%20issue)
are drawn from the Next section. Comment to claim one. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
