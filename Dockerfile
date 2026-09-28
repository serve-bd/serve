# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-alpine AS runner
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client openssl ca-certificates tini curl bash \
  && (curl -sSL https://nixpacks.com/install.sh | bash || echo "nixpacks not installed")
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SERVE_MIGRATIONS_DIR=/app/drizzle \
    SERVE_DATA_DIR=/data/serve
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/dist/worker.cjs ./worker.cjs
COPY --from=build /app/drizzle ./drizzle
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD [ "$SERVE_ROLE" = "worker" ] || curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["web"]
