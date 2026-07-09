# Traycer web app: serves the GUI (clients/web) next to a provisioned Traycer
# host inside one container. See clients/web/README.md.
#
#   docker build -t traycer-web .
#   docker run --rm -p 8788:8788 -v traycer-home:/root/.traycer traycer-web
#
# The entrypoint downloads + minisign-verifies the signed host release via the
# CLI (`host ensure --no-service-register`; pin with -e TRAYCER_HOST_VERSION),
# runs the host supervisor directly (no systemd in a container - `traycer host
# start` is the same foreground command a systemd unit would ExecStart), and
# starts the web server on 0.0.0.0:8788.

FROM oven/bun:1.3.12 AS build
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile
RUN bunx nx run @traycer-clients/web:build --tui=false

FROM oven/bun:1.3.12
WORKDIR /workspace
# The CLI and the serve process both run from source under bun, so the runtime
# image carries the installed workspace from the build stage wholesale.
COPY --from=build /workspace /workspace
RUN chmod +x /workspace/docker/entrypoint.sh

ENV TRAYCER_WEB_PORT=8788
EXPOSE 8788
# Host install + credentials persist across container restarts.
VOLUME /root/.traycer

ENTRYPOINT ["/workspace/docker/entrypoint.sh"]
