# Testing

```bash
bun test                # everything
bun test packages/backend
bun test --watch
bun run coverage
bun run verify          # what CI runs
```

Tests use [`bun:test`](https://bun.sh/docs/test/test.md). No test framework to
install.

## Layout

```
packages/protocol/tests/    wire contracts, hostile payloads
packages/backend/tests/     address classification, flight lifecycle, stats,
                            and a live Socket.IO integration suite
packages/frontend/tests/    codec, incremental hashing, file collection
```

## What is covered, and why

### The crash regression

`packages/backend/tests/signaling.test.ts` →
`the server survives malformed traffic`

This is the most important test in the repository. It fires nineteen malformed
or hostile payloads at a live server — missing arguments, wrong types,
wrong-sized SDP, non-objects, absurd numbers — and then asserts that a brand new
client can still connect and create a flight.

It exists because `socket.on('answer', (code, { sdp }) => …)` destructured its
second argument. Socket.IO does not catch exceptions from listeners, and Node and
Bun terminate the process on an uncaught exception, so any client sending
`answer` with one argument restarted the service for everyone. If this test ever
fails, the process is one bad packet from going down.

The teardown hook is itself a regression test: `server.close()` waits for every
connection and a WebSocket never ends on its own, so the suite hung for the full
timeout until `closeAllConnections()` was added. That was the deploy-time hang.

### Reassembly

`packages/frontend/tests/codec.test.ts`

The old code had no reassembly because the channel was reliable and ordered. The
bulk channels are now partially reliable, so out-of-order delivery is expected.
Covers duplicates, long out-of-order runs, gap detection and reset.

### Integrity

`packages/frontend/tests/hash.test.ts`

Incremental SHA-256 against the NIST vectors, then against `crypto.subtle` for
**every input length from 0 to 200** and for chunk sizes from 1 byte to the whole
input. Padding bugs only surface at specific block boundaries, so the boundary
cases are the tests that actually matter.

### Folder traversal

`packages/frontend/tests/collectFiles.test.ts`

Fakes a directory reader that batches 100 entries per call, exactly as the real
API does, and asserts a 250-file folder is fully collected. The old code called
`readEntries()` once and silently dropped everything past the first hundred.

Also covers `sanitizePath`, which is a trust boundary: a path arrives from a peer
and the receiver writes to a real filesystem.

### Address classification

`packages/backend/tests/net.test.ts`

CGNAT, link-local, loopback, documentation ranges, IPv4-mapped IPv6, and proxy
trust. Three bugs here were found by the tests rather than designed, including a
`/128` block for `::1` that matched almost all of IPv6.

## Writing tests

**Reproduce the bug first.** Write the failing test, watch it fail, then fix it.
That ordering is what makes the regression meaningful.

**Assert behaviour, not implementation.** A test that breaks when a private field
is renamed is a maintenance cost with no benefit.

**Prefer the real thing where it is cheap.** The backend suite talks to a real
Socket.IO server over a real socket. Mocking the thing under test is how tests end
up asserting that the mock was called.

**Name the bug in the comment.** Explain why the assertion exists so the next
person does not "simplify" it away. Several tests here read as over-specified
until you know the crash they prevent.

## Not yet covered

Honest gaps, all welcome as first contributions:

- **End-to-end browser tests.** The four network scenarios in
  [NETWORKING.md](NETWORKING.md) need real devices, which CI does not have.
- **Multi-peer mesh negotiation.** Flights are capped at two peers today.
- **Load testing.** A soak test at a few thousand concurrent sockets would tell
  us where the ceiling actually is.
- **Visual regression** on the UI.
- **Fuzzing** the codec with random bytes.
