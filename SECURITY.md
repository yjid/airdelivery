# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Open a
[private security advisory](https://github.com/GochiStuff/airdelivery/security/advisories/new)
instead.

Please include:

- What the vulnerability is and what an attacker gains
- Steps to reproduce, ideally a flight code or a minimal client snippet
- Which component is affected (signaling server, web client, transfer engine)
- Whether any real user data could have been exposed

You should get an acknowledgement within 72 hours and a substantive response
within 7 days. We will tell you when a fix ships and will credit you in the
advisory unless you would rather we did not.

## Threat model

AirDelivery is peer to peer, which changes what an attacker can actually reach.

**The server never holds file data.** It relays SDP descriptions and ICE
candidates so two browsers can connect, and that is all. A compromise of the
signaling server does not reveal file contents, because they were never there.

What the server _does_ see:

- Socket IDs, which are ephemeral and rotate on every connection
- A partially masked IP address, used transiently to discover devices on the
  same local network and discarded on disconnect
- Aggregate counters: files transferred and total bytes. No names, no contents,
  no addresses

**The transport is not encrypted by us.** WebRTC encrypts data channels with
DTLS-SRTP, which is mandatory in every implementation. Metadata is visible to
anyone on the path: the IP addresses of both peers, and the fact that a transfer
is happening. A TURN relay sees encrypted payloads and connection metadata.
If you need to hide that you are transferring at all, use a VPN — and if hiding
it matters to you, do not use a public TURN relay either.

**A malicious peer can send you a malicious file.** Nothing about the protocol
inspects content. Files are verified with SHA-256 against a digest the _sender_
provides, which detects corruption and reordering but proves nothing about
intent. Treat received files as you would any other download.

**A malicious peer can write to your disk**, via the storage path it requests.
Paths are sanitised: `..` segments are stripped and characters that are illegal
or dangerous on any target OS are replaced, so a sender cannot choose a location
outside the destination. It can still choose a filename, so a hostile sender can
overwrite an existing file if you accept a transfer to a name already in use.

**Replay and downgrade.** Flight codes are short by design so they can be read
aloud. A code is only valid while its creator's connection lives, flights are
capped at two peers, and expired flights are swept. Do not treat a flight code
as a secret.

## Hardening already in place

- Every inbound Socket.IO payload is schema-validated with an explicit size cap
- Every signaling event is authorized against flight membership and ownership
- Listener exceptions are isolated, so one malformed packet cannot take down the
  service for other users
- SDP is capped at 64 KB and socket frames at 256 KB
- Per-socket event budgets stop one client starving the event loop
- `X-Forwarded-For` is trusted only behind a configured proxy, so addresses
  cannot be spoofed
- Addresses are stored hashed, never written to logs in raw form
- `helmet` with a Content-Security-Policy, and `X-Frame-Options`
- Self-hosted instances: the server binds and stores no credentials, and the
  database is not published by the default compose file

## Deploying it yourself

- Set `TRUST_PROXY_HOPS` correctly. An incorrect value either breaks rate
  limiting or allows `X-Forwarded-For` spoofing.
- Configure a TURN relay you control, if you expect users on restrictive
  networks. Third-party relays see connection metadata.
- Terminate TLS at your proxy. Plain HTTP works, but `crypto.subtle` and the
  storage APIs require a secure context, so several features silently degrade.
- Keep the database off the public internet.
- Note that state is in-memory, so the server must run as a single instance
  unless you add a Socket.IO adapter. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Supported versions

Only the latest `main` is supported. There are no released tags yet.
