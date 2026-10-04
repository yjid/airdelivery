# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# deps — install with the lockfile, cached separately from source.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.10-alpine AS deps
WORKDIR /app

# Only manifests, so this layer is reused whenever source changes.
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

# --production keeps devDependencies out of the runtime image. The backend
# bundles to a single file, so nothing else is needed at runtime.
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# build — compile the whole workspace with dev deps available.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.10-alpine AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN bun install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/backend packages/backend

# --outdir rather than --outfile: with an absolute --outfile this Bun build
# prints a successful summary and leaves the directory empty, so the COPY below
# fails with a misleading "file does not exist" that points at the COPY rather
# than at the build. --sourcemap=external has the same requirement, and would
# otherwise have shipped a bundle with the source map silently dropped.
RUN bun build --target=bun --minify \
      --outdir=/out packages/backend/src/server.ts

# ---------------------------------------------------------------------------
# runtime — minimal, non-root, with a real healthcheck.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.10-alpine AS runtime
WORKDIR /app

# curl is needed by the healthcheck below.
RUN apk add --no-cache curl \
 && addgroup -g 1001 -S airdelivery \
 && adduser  -u 1001 -S airdelivery -G airdelivery

COPY --from=deps  /app/node_modules      ./node_modules
COPY --from=build /out/server.js        ./server.js
COPY --from=build /app/package.json     ./package.json

ENV NODE_ENV=production \
    PORT=5500 \
    # Unref'd timers and the bounded shutdown mean the process exits on its own,
    # but be explicit so an orchestrator never has to SIGKILL us.
    NODE_OPTIONS=--max-old-space-size=512

USER airdelivery
EXPOSE 5500

# Liveness only. Deliberately does NOT depend on Mongo: a database outage must
# not make the orchestrator kill a healthy signaling process. Dependency state
# is reported separately on /api/v1/ready.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" || exit 1

# Exec form so PID 1 is Bun and receives SIGTERM directly. Without this the
# container is SIGKILLed after the grace period and every live transfer is cut.
STOPSIGNAL SIGTERM

# `bun run <file>` resolves against package.json scripts before the
# filesystem, so with no such script the container exits immediately with
# "Module not found". An explicit relative path runs the file.
CMD ["bun", "./server.js"]
