# Glossary

**AirDelivery** — the project. A browser-to-browser file transfer built on WebRTC.

**Flight** — a transfer session, identified by a six-character code. Two peers
maximum. Ephemeral: nothing is stored, and it expires.

**Flight code** — six characters from an unambiguous alphabet (no `0`/`O`,
`1`/`I`/`L`), so a code read aloud and retyped resolves. Normalised on both ends,
so lowercase, stray spaces and mistyped look-alikes all work.

**Signaling** — relaying the SDP offer, answer and ICE candidates so two browsers
can find each other. The server does this and nothing else.

**Peer connection** — the direct connection between two browsers. Established via
ICE, and it carries the file data without touching the server.

**SDP** — a session description: the codec capabilities and candidate gathering
information two peers exchange. Large-ish, which is why it is size-capped.

**ICE** — Interactive Connectivity Establishment. Finds a path between two
peers by gathering candidates and testing them pairwise.

**Candidate** — one possible path, of a type:

| Type    | Meaning                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------- |
| `host`  | A local address. Two devices on the same LAN connect this way: fastest possible.               |
| `srflx` | A server-reflexive address, discovered via STUN. Means there is a NAT in the way.              |
| `relay` | A relayed address via TURN. Works when nothing else does; slower, and the relay sees metadata. |

**STUN** — a public server that tells you your own public address. Discovery
only; cannot connect two peers.

**TURN** — a public relay that carries traffic for peers with no direct path.
Required on most campus and corporate networks.

**NAT** — Network Address Translation. The router rewrites your private address
to a public one, which is why two peers behind different NATs cannot simply talk.

**CGNAT** — Carrier-Grade NAT. Extra addressing sharing used by mobile carriers,
including for phone hotspots. Falls in `100.64.0.0/10`. AirDelivery treats it as
a local network.

**Symmetric NAT** — a NAT that gives every destination a different mapped port,
so inbound connections cannot be predicted. No direct path exists; TURN is the
only option.

**Data channel** — a WebRTC channel carrying arbitrary data, encrypted with
DTLS-SRTP by the browser. This is what file chunks travel over.

**Ordered vs partially reliable** — a fully reliable channel stalls the whole
transfer on one lost packet. AirDelivery's bulk channels are unordered with a
retransmit limit, and the receiver reassembles by sequence number.

**Backpressure** — not sending faster than the receiver can absorb. AirDelivery
pauses the sender when the receive buffer passes a high-water mark, because an
unbounded buffer is an out-of-memory crash waiting to happen.

**OPFS** — Origin Private File System. A real filesystem scoped to the origin,
available in Safari 17+ and Chrome on Android. It is what lets a phone stream a
multi-gigabyte file to disk without the user picking a folder first.

**Integrity check** — comparing a SHA-256 digest of what arrived against the
sender's. Catches corruption and reordering. Per-chunk CRC catches corruption
cheaply; the whole-file digest catches reordering, which a CRC structurally
cannot.

**Nearby users** — other devices on the same network prefix, discovered by
comparing IP prefixes. Requires everyone to be able to reach the signaling
server, and reveals nothing about file contents.
