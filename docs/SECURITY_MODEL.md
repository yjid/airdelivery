# Security model

The threat model, and what is deliberately _not_ defended against, are documented
in [../SECURITY.md](../SECURITY.md). This page covers the mechanics.

## Trust boundaries

```
untrusted                    your server                     untrusted
browser  ──────────────────►  validating, authorizing  ──────►  browser
                              trust boundary
```

The browser is the only untrusted party, and it is untrusted in the strong
sense: anyone can open devtools and emit arbitrary frames.

## Validation

Every inbound frame is parsed against a schema from `@airdelivery/protocol`
before anything else touches it.

- Zod schemas with `.strict()` semantics on nested objects, so unknown fields do
  not pass through.
- Explicit size caps: SDP at 64 KB, an ICE candidate at 2 KB, a socket frame at
  256 KB. An unbounded SDP field would let any client make the server retain an
  arbitrarily large object per flight.
- Codes are normalised then validated against a fixed alphabet and length.
  Normalisation is what lets a lowercase or mistyped code resolve instead of
  failing.
- Statistical counters are clamped, so one client cannot poison analytics with
  `Number.MAX_VALUE`.

## Authorization

Every signaling event proves membership of the flight it names, and mutating
events additionally check ownership. There are no exceptions: a client that is
not in a flight cannot store an SDP on it, cannot relay an ICE candidate into it,
and cannot learn its members.

The previous server had none of these checks, which meant any connected client
could hijack any transfer by naming its six-character code.

## Isolation

Socket.IO does not catch exceptions thrown from listeners, and Node and Bun both
terminate the process on an uncaught exception. Every listener is therefore
registered through a wrapper that catches, logs with context, and answers the
client's ack so a caller cannot be left awaiting a callback that never fires.

Repeat failures are collapsed to one line per 60 s per signature so a retry loop
cannot flood the logs.

Process-level guards keep serving for contained errors and exit only for errors
explicitly classified as fatal.

## Resource limits

- Per-socket event budgets over a sliding window.
- Flight TTL with a sweeper, so a backgrounded mobile tab cannot squat a code.
- Receive queue high-water mark and hard limit.
- Bounded statistics buffers.
- `maxHttpBufferSize` well below the default.

## Address handling

- `X-Forwarded-For` and `CF-Connecting-IP` are honoured **only** when a trusted
  proxy is configured. Trusting them unconditionally lets any client claim any
  address and poison nearby-device buckets.
- Addresses are stored hashed and never written to logs in raw form.
- `trust proxy` is set from configuration, which is what makes rate limiting key
  on the real client rather than the load balancer.

## What we do not defend against

- **A malicious sender.** Files are verified against a digest the sender
  provides, which detects corruption but proves nothing about intent. A sender
  can choose a filename and so can overwrite an existing one.
- **Traffic analysis.** Anyone on the path can see that a transfer happened and
  which addresses were involved. A TURN relay sees encrypted payloads and
  connection metadata.
- **Traffic analysis via our server.** Flight codes are short so they can be
  read aloud, and are valid only while the creator's connection lives.

These are properties of a peer-to-peer design, not oversights. If they matter to
your use case, that is a signal to self-host.
