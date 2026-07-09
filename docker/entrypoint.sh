#!/usr/bin/env bash
# Container entrypoint for the Traycer web app (see Dockerfile).
#
# 1. Provision the signed host release via the CLI. `--no-service-register`
#    installs + verifies the bytes without touching a service manager
#    (there is no systemd inside the container).
# 2. Run `traycer host start` in the background: it is the same foreground
#    supervisor a systemd unit would ExecStart, so no service manager is
#    needed - the entrypoint forwards TERM/INT for a clean `docker stop`.
# 3. Run the web server (static bundle + host WS proxy + authn proxy) in the
#    foreground on 0.0.0.0 - the container port mapping is the exposure
#    boundary.
set -euo pipefail

cd /workspace

cli() {
  bun clients/traycer-cli/src/index.ts "$@"
}

if [ -n "${TRAYCER_HOST_VERSION:-}" ]; then
  cli host ensure --no-service-register --release "$TRAYCER_HOST_VERSION"
else
  cli host ensure --no-service-register
fi

cli host start &
host_pid=$!

bun clients/web/src/server/serve.ts --bind 0.0.0.0 --port "${TRAYCER_WEB_PORT:-8788}" &
web_pid=$!

forward_term() {
  kill -TERM "$host_pid" "$web_pid" 2>/dev/null || true
}
trap forward_term TERM INT

# Exit when either process dies; then stop the sibling so the container never
# lingers half-alive (docker restart policy takes it from there).
wait -n "$host_pid" "$web_pid"
status=$?
forward_term
wait "$host_pid" "$web_pid" 2>/dev/null || true
exit "$status"
