# Deployment

The signaling server holds no file data and no accounts, so there is nothing to
back up and nothing to migrate.

## State

Flights, users and nearby-discovery buckets live in memory. That has two
consequences:

- **Restarting drops in-flight flights.** Clients get an explicit
  `flightDeleted` with reason `server-shutdown` and can create a new one.
- **You must run a single instance** unless you add a Socket.IO adapter. Two
  instances behind a load balancer would each know about half the flights and
  users would be told their flight does not exist.

A single instance handles a very large number of concurrent transfers; the work
per transfer after connection setup is confined to the two browsers.

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f signal
```

Brings up the signaling server and MongoDB. The database is not published to the
host.

## Health checks

| Endpoint         | Meaning                         | Use for               |
| ---------------- | ------------------------------- | --------------------- |
| `/api/v1/health` | The process is up               | Liveness probe        |
| `/api/v1/ready`  | Dependencies are reported       | Readiness, dashboards |
| `/api/v1/config` | ICE servers and transfer tuning | Diagnostics           |

`/api/v1/health` deliberately does **not** depend on MongoDB. A database outage
should not make an orchestrator kill a healthy signaling process; transfers keep
working without it.

## Graceful shutdown

On `SIGTERM` the server stops accepting work, tells every client why, flushes
statistics under a two-second cap, force-closes remaining sockets and exits.

**Set your orchestrator's grace period above `SHUTDOWN_TIMEOUT_MS`** (10 s by
default). Docker's `stop_grace_period` and Kubernetes' `terminationGracePeriodSeconds`
should both be at least 20 s, otherwise the `SIGKILL` wins and in-flight
transfers are cut. CI asserts this by sending `SIGTERM` and requiring the
container to stop within 20 s.

## Platform notes

### Fly.io

```toml
[[vm]]
  memory = "512mb"

[http_service]
  internal_port = 5500
  force_https = true
  auto_stop_machines = false    # a stopped machine drops every flight
  auto_start_machines = true
  min_machines_running = 1
```

### Railway / Render

Start command `bun run --filter backend start`, health check path
`/api/v1/health`. Both support multi-instance, so keep it at one replica unless
you have added an adapter.

### Plain VPS

```bash
bun install --frozen-lockfile --production
bun run --filter backend start
```

Run under systemd or PM2 with a restart policy. Configure `TRUST_PROXY_HOPS=1`
if anything sits in front.

## Post-deployment checklist

1. `TRUST_PROXY_HOPS` is set correctly. Wrong means rate limiting buckets every
   user together and nearby-device discovery breaks.
2. TLS is terminated at your proxy. Plain HTTP disables `crypto.subtle` and the
   storage APIs, so integrity checking and disk streaming silently turn off.
3. **A TURN relay is configured.** Without one, users on campus and corporate
   networks cannot connect at all. See [NETWORKING.md](NETWORKING.md).
4. `LOG_LEVEL=info` in production and `DEBUG` off. Debug logging is high volume
   and slows the event loop under load.
5. Health checks wired to `/api/v1/health`.
6. Grace period above `SHUTDOWN_TIMEOUT_MS`.
7. Logs are being collected. If you have not configured error reporting, a crash
   is currently only visible as a gap in the logs.
