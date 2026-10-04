# syntax=docker/dockerfile:1.7
# Dependencies and the build run on the runner's own platform: the output is plain
# JavaScript, and building under emulation for other platforms is slow and crashes.
# Only the pnpm version of package.json: the version bump of a release must not make the
# dependency layers below miss the build cache.
FROM --platform=$BUILDPLATFORM node:22-alpine AS pm
COPY package.json /tmp/
RUN node -e 'const p = require("/tmp/package.json"); require("fs").writeFileSync("/pm.json", JSON.stringify({ packageManager: p.packageManager }))'

FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY --from=pm /pm.json ./package.json
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
# Packages come from the lockfile alone, so this layer stays cached until dependencies change.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch --frozen-lockfile
COPY package.json ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --offline

FROM --platform=$BUILDPLATFORM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# The metrics agent remote servers run (agent/), for both server architectures. Serve copies the
# right one to each server, so no separate image is published.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS agent
ARG SERVE_VERSION=""
WORKDIR /src
COPY agent/ ./
RUN for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=${SERVE_VERSION#v}" -o /out/serve-agent-linux-$arch . || exit 1; \
    done

FROM node:22-alpine AS runner
# Checks the release signature of an image before an update installs it.
COPY --from=ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8 /ko-app/cosign /usr/local/bin/cosign
# Shown in Settings → Updates; set by the image workflow.
ARG SERVE_COMMIT=""
ARG SERVE_VERSION=""
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git git-lfs openssh-client openssl ca-certificates tini curl bash \
  && (curl -sSL https://nixpacks.com/install.sh | bash || echo "nixpacks not installed")
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SERVE_MIGRATIONS_DIR=/app/drizzle \
    SERVE_DATA_DIR=/data/serve \
    SERVE_COMMIT=${SERVE_COMMIT} \
    SERVE_BUILD_VERSION=${SERVE_VERSION}
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/dist/worker.cjs ./worker.cjs
COPY --from=agent /out/ ./dist/agent/
COPY --from=build /app/drizzle ./drizzle
# The updater installs these from the new image, so the stack definition always matches the code.
COPY docker/compose.yml /app/deploy/compose.yml
COPY scripts/restore-instance.sh /app/deploy/restore-instance.sh
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD [ "$SERVE_ROLE" = "worker" ] || curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["web"]
