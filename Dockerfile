# CIC web app: the host server (host/) and the web GUI (clients/web) in one
# container. Fully self-contained - no accounts, no external downloads at
# runtime. See clients/web/README.md.
#
#   docker build -t cic-web .
#   docker run --rm -p 8788:8788 -v cic-home:/root/.cic cic-web
#
# Agent turns need an OpenClaw Gateway reachable from the container; point the
# host at it with -e CIC_OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789.

FROM oven/bun:1.3.12 AS build
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile
RUN bunx nx run @cic/web:build --tui=false

FROM oven/bun:1.3.12
WORKDIR /workspace
# The host and the serve process both run from source under bun, so the
# runtime image carries the installed workspace from the build stage wholesale.
COPY --from=build /workspace /workspace
RUN chmod +x /workspace/docker/entrypoint.sh

ENV CIC_WEB_PORT=8788
EXPOSE 8788
# Chats, epics, worktrees, and settings persist across container restarts.
VOLUME /root/.cic

ENTRYPOINT ["/workspace/docker/entrypoint.sh"]
