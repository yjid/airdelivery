# Networking

Peer-to-peer connections fail for a small number of reasons, and almost all of
them look identical from the browser: "connecting…" forever. This page explains
what is actually happening.

## The two phases

Establishing a connection has two independent phases, and they fail differently.

**Signaling** goes through our server: the SDP offer, the answer, and ICE
candidates. It is ordinary HTTPS and WebSocket, so it works wherever the website
works.

**Peer connectivity** is direct between the two browsers, using UDP where
possible and TURN (a relay) where not. This is where it fails.

## STUN and TURN

|          | What it does                                     | When it is needed                               |
| -------- | ------------------------------------------------ | ----------------------------------------------- |
| **STUN** | Asks a public server what your public address is | Almost always, for discovering your own address |
| **TURN** | Relays your traffic through a public server      | When there is no direct path                    |

STUN is not enough. It only tells each side its own public address; it cannot
connect two peers who both sit behind NAT. Whether a direct path exists depends
on the NAT types involved:

- **Full cone / restricted cone**: usually fine. STUN suffices.
- **Port-symmetric NAT**: no direct path exists at all. **TURN is required.**
- **Carrier-grade NAT**: used by most mobile carriers, including phone hotspots.
  Often behaves like symmetric NAT.

**If your operator has not configured a TURN relay, transfers on campus and
office networks cannot work.** This is not a bug in AirDelivery; it is a
property of those networks. Operators should read
[DEPLOYMENT.md](DEPLOYMENT.md).

## Why one network works and another does not

### Mobile hotspot

Usually the easiest case. The phone hands out addresses on a private range
(`192.168.43.x`, `172.20.10.x`, or CGNAT `100.64.x.x`), and both devices can
reach each other directly, so host candidates win and a relay is never used.

AirDelivery classifies CGNAT, link-local, loopback and all RFC1918 ranges as
local. Earlier versions treated `100.64.0.0/10` as public, which is the range
carriers actually use for hotspots — so hotspot discovery found nobody at all.

### Laptop and phone on the same Wi-Fi

Works, and is fast. Both devices can reach each other directly, so the transfer
never leaves your network and never touches a relay.

One caveat: if the AP has client isolation enabled (common on guest and campus
networks), clients cannot reach each other even though they share a subnet. The
symptom is a permanent "connecting…". Test with isolation off.

### Campus Wi-Fi

Frequently fails, for three compounding reasons:

1. **Aggressive NAT** at the network edge, often port-symmetric.
2. **Firewall rules** that block arbitrary UDP between clients, and sometimes
   drop it silently.
3. **Idle timeouts** that kill UDP flows quickly. A flow that works for the ICE
   handshake may be torn down mid-transfer. AirDelivery handles this by
   detecting the disconnect and performing a real ICE restart, and the server
   enables Socket.IO connection-state recovery so a brief drop does not lose the
   flight.

The remedy is a TURN relay, and a permissive UDP policy.

### Corporate / office

Hardest, and usually for reasons outside your control:

1. **Proxies that strip the WebSocket upgrade.** AirDelivery falls back to HTTP
   long-polling and upgrades afterwards, so this is usually survivable. An older
   version forced `websocket`-only transport and could not connect at all.
2. **TLS interception.** A proxy that re-signs TLS breaks some things, but
   WebRTC's DTLS-SRTP is negotiated end to end and is unaffected.
3. **Symmetric NAT with no UDP at all.** TURN over TCP on port 443 is the only
   thing that works, and most operators do not configure it.

Expect a TURN relay to be mandatory here. Also note that a corporate proxy may
block third-party STUN entirely.

## Diagnosing a failure

Open `chrome://webrtc-internals` on both devices, or use the in-app
troubleshooting panel, and look at:

| State                                       | Meaning                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `iceConnectionState: checking`              | Candidates are still being gathered. Normal for a second or two.                    |
| `iceConnectionState: failed`                | ICE exhausted every path. Almost always no TURN configured, or AP client isolation. |
| `connectionState: disconnected`             | The flow dropped mid-transfer. AirDelivery attempts one ICE restart.                |
| `connectionState: failed` after a long wait | Two different NATs, no relay.                                                       |

The useful diagnostic is the **candidate pair** that was selected:

- A `typ host` pair means a direct local connection — the fast path.
- A `typ srflx` pair means STUN worked and you are going through a NAT.
- A `typ relay` pair means TURN is working and you are being relayed. This works
  but is slower and your throughput is capped by the relay.

If no `typ relay` pair appears and the connection fails, there is no relay
configured.

## For operators

TURN is fully environment-driven with no baked-in default. See
[`.env.example`](../.env.example).

Two things get people caught:

- **`TRUST_PROXY_HOPS`.** Without it, every request appears to come from your
  reverse proxy, so `X-Forwarded-For` is ignored and nearby-device discovery
  breaks — everyone looks like they is on the same network.
- **Plain HTTP.** `crypto.subtle` and both storage APIs require a secure context.
  Over HTTP, integrity verification and disk streaming silently disable
  themselves. Terminate TLS at your proxy.
