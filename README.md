<div align="center">

# AirDelivery

**Send files straight from one device to another. No cloud, no accounts, no size limit.**

[Live site](https://airdelivery.site) · [How it works](https://airdelivery.site/guide/p2p-file-sharing) · [Report an issue](https://github.com/GochiStuff/airdelivery/issues) · [Contribute](CONTRIBUTING.md) · [Security](SECURITY.md)

[![CI](https://github.com/GochiStuff/airdelivery/actions/workflows/ci.yml/badge.svg)](https://github.com/GochiStuff/airdelivery/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## What it does

Two devices connect directly to each other over WebRTC. The server introduces
them and then gets out of the way — **file data never reaches it**. There is no
account, no upload, and no limit on how large a file can be.

- Multi-file and whole-folder transfer, with folder structure preserved
- Pause, resume and cancel per file
- Live progress, throughput and speed
- SHA-256 integrity verification on every transfer
- Streams to disk, so a 20 GB file needs no more memory than a 20 MB one
- Installs as an app (PWA), works offline once loaded
- Free and MIT licensed

## How it works

```
   sender browser                          receiver browser
        |                                         |
        |  1. both connect to the signaling server |
        |------------------------------------------>|
        |                                         |
        |  2. exchange SDP offer/answer + ICE      |
        |<---------------------------------------->|
        |        (via the signaling server)        |
        |                                         |
        |  3. direct peer-to-peer data channel     |
        |<========== file chunks =================>|
        |         server sees none of this         |
```

Only step 2 passes through the server. From step 3 the two browsers talk
directly. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detail and
[docs/NETWORKING.md](docs/NETWORKING.md) for how this behaves on real networks.

## Repository layout

```
packages/
  protocol/   @airdelivery/protocol — validated wire contracts shared by both sides
  backend/    @airdelivery/backend  — signaling server. Never sees file data
  frontend/   @airdelivery/frontend — Next.js client and transfer engine
docs/         architecture, networking, roadmap, ADRs
```

## Getting started

Requires [Bun](https://bun.sh) 1.3 or newer.

```bash
git clone https://github.com/GochiStuff/airdelivery.git
cd airdelivery
bun install
cp .env.example .env     # optional; the server runs without a database
bun dev                  # frontend on :3000, backend on :5500
```

Or with Docker, which brings its own MongoDB:

```bash
docker compose up -d --build
docker compose logs -f signal
```

Run everything CI runs:

```bash
bun run verify
```

## Configuration

Every variable is validated at startup — the server refuses to boot on a
misconfiguration rather than half-working. See
[`.env.example`](.env.example) for the full annotated list.

Two matter most in production:

| Variable                      | Why                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY_HOPS`            | **Required behind any load balancer.** Without it every request appears to come from your proxy, so rate limiting buckets all users together and `X-Forwarded-For` is ignored.                        |
| `TURN_URLS` / `TURN_USERNAME` | **Required for campus and corporate networks.** STUN alone cannot traverse symmetric NAT, so without a TURN relay those networks simply cannot connect. See [docs/NETWORKING.md](docs/NETWORKING.md). |

## Deploying

The server is stateless apart from in-memory flight state, so a single instance
is enough for a very large number of concurrent transfers. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for Docker, Fly.io, Railway and plain
VPS, plus the health-check contract.

## Contributing

Contributions are genuinely welcome, including first ones — see
**[CONTRIBUTING.md](CONTRIBUTING.md)**. Issues tagged
[`good first issue`](https://github.com/GochiStuff/airdelivery/labels/good%20first%20issue)
are a reasonable place to start, and you can claim one by commenting on it.

Useful starting points:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit together
- **[docs/NETWORKING.md](docs/NETWORKING.md)** — NAT, STUN, TURN, and why your connection failed
- **[docs/TESTING.md](docs/TESTING.md)** — how to run and write tests
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what is being worked on
- **[docs/ADRs/](docs/adr/)** — why things are the way they are

If something is broken, unclear, or documented incorrectly, that is a bug worth
reporting. Documentation fixes are as welcome as code.

## Security

Found a vulnerability? Please read **[SECURITY.md](SECURITY.md)** and report it
privately rather than opening a public issue.

## License

[MIT](LICENSE). Use it, self-host it, fork it, audit it.
