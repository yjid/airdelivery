# Contributing to AirDelivery

Thanks for being here. This project is MIT licensed and built in the open, and
contributions of every size are genuinely welcome — including your first.

**You do not need to be a WebRTC expert.** Issues labelled
[`good first issue`](https://github.com/GochiStuff/airdelivery/labels/good%20first%20issue)
exist precisely so you can start without one. Comment on one to claim it.

## Quick start

```bash
git clone https://github.com/GochiStuff/airdelivery.git
cd airdelivery
bun install
cp .env.example .env
bun dev
```

Requires [Bun](https://bun.sh) 1.3+. Node 20.11+ works for the frontend, but
`bun test` and `bun run` are the supported path.

Then run what CI runs:

```bash
bun run verify   # format:check + lint + typecheck + test + build
```

Getting that green before you open a PR saves everyone a round trip.

## Where to contribute

| Area              | Start here                                | Notes                                    |
| ----------------- | ----------------------------------------- | ---------------------------------------- |
| User interface    | `packages/frontend/app`, `components`     | Any framework knowledge works            |
| Transfer engine   | `packages/frontend/hooks`, `lib/transfer` | Pure logic, heavily unit tested          |
| Signaling server  | `packages/backend/src`                    | Node + Socket.IO                         |
| Network behaviour | `docs/NETWORKING.md`                      | Hard to test, very high value            |
| Documentation     | `docs/`, `README.md`                      | The least crowded and immediately useful |
| PWA / offline     | `public/sw.js`                            |                                          |

If you are unsure, open an issue and ask. That is a perfectly good first
contribution too.

## How the codebase is organised

```
packages/
  protocol/   Validated contracts for every message between client and server.
              One schema per message, imported by both sides.
  backend/    The signaling server. Relays SDP and ICE. Never sees file data.
  frontend/   Next.js client, WebRTC session management, transfer engine.
```

Two conventions worth knowing before you write code:

**Add schemas, not ad-hoc validation.** Any message crossing the wire belongs in
`packages/protocol` with an explicit size cap. That is how the two sides are kept
from drifting, and it is how a hostile payload gets rejected before it reaches
your handler.

**Keep the hot path free of allocations.** The transfer loop runs thousands of
times per second. Prefer reused buffers, hoisted encoders, and
`yieldToEventLoop()` over `setTimeout`.

Both are explained further in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Making a change

1. Open an issue first for anything substantial. UI/UX changes especially — a
   mockup or two minutes of discussion saves an hour of rejected work.
2. Branch from `main`: `git checkout -b fix/short-description`.
3. Write a test that fails before your fix, if the change is a bug fix.
4. Keep the diff focused. One concern per PR.
5. Add a changeset if it affects users: `bunx @changesets/cli`.
6. Run `bun run verify`.
7. Open a PR describing what changed and why.

### Commit messages

Explain the why, not the what:

```
fix(server): bound graceful shutdown so deploys stop being SIGKILLed

server.close() waits for every open connection, and a WebSocket never ends on
its own, so shutdown hung until the platform killed the process — a hard cut
for every in-flight transfer on every deploy.
```

### Pull requests

Include what you changed, why, and how you tested it. Add screenshots for
anything visual. If you fixed a bug, say what you did to reproduce it first.

## Reporting bugs

Open an issue with:

- What you did, what you expected, what happened instead
- Browsers, devices and network (home Wi-Fi, mobile hotspot, campus, office,
  VPN) — this matters enormously here, see [docs/NETWORKING.md](docs/NETWORKING.md)
- Whether the console shows anything

If a transfer fails, the single most useful thing is the pair of
`(connectionState, iceConnectionState)` values from `chrome://webrtc-internals`.
There is a troubleshooting page in the app for exactly this.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the [MIT licence](LICENSE).
