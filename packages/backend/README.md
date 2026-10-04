# @airdelivery/backend

The AirDelivery signaling server. Exchanges WebRTC offers, answers and ICE
candidates so two browsers can connect.

**It never sees file data.** See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

```bash
bun run dev        # watch mode
bun run start      # production
bun test           # 144 tests
bun run typecheck
```

Configuration is validated at startup; the process refuses to boot on a
misconfiguration. See [../../.env.example](../../.env.example) for every variable.

Two matter most in production:

- `TRUST_PROXY_HOPS` — required behind a load balancer. Without it, rate limiting
  buckets every user under your proxy's IP and nearby-device discovery breaks.
- `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` — required for campus and
  corporate networks. STUN alone cannot traverse symmetric NAT, so without a
  relay those networks cannot connect at all. Served to clients from
  `GET /api/v1/config`.

Health checks: `/api/v1/health` for liveness (deliberately independent of
MongoDB), `/api/v1/ready` for dependency state.

## Layout

| Path                     | Responsibility                                             |
| ------------------------ | ---------------------------------------------------------- |
| `src/config/`            | Validated environment configuration                        |
| `src/socket/guard.ts`    | Listener isolation and process guards                      |
| `src/socket/handlers.ts` | Validate, authorize, route every event                     |
| `src/services/`          | Flight lifecycle, user registry, statistics, client config |
| `src/utils/net.ts`       | CIDR-based address classification                          |
| `tests/`                 | Unit suites plus a live Socket.IO integration suite        |
