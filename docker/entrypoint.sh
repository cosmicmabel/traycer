#!/usr/bin/env bash
# Container entrypoint for the CIC web app (see Dockerfile).
#
# 1. Run the host server (host/) in the background - it binds loopback inside
#    the container and writes the pid.json the web server discovers it with.
# 2. Run the web server (static bundle + host WS proxy) in the foreground on
#    0.0.0.0 - the container port mapping is the exposure boundary.
#
# The OpenClaw Gateway is NOT part of this container; point the host at yours
# with CIC_OPENCLAW_GATEWAY_URL (e.g. ws://host.docker.internal:18789).
set -euo pipefail

cd /workspace

host_args=()
if [ -n "${CIC_OPENCLAW_GATEWAY_URL:-}" ]; then
  host_args+=(--openclaw-gateway-url "$CIC_OPENCLAW_GATEWAY_URL")
fi
if [ -n "${CIC_OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  host_args+=(--openclaw-gateway-token "$CIC_OPENCLAW_GATEWAY_TOKEN")
fi

bun host/src/index.ts --port 47100 "${host_args[@]}" &
host_pid=$!

bun clients/web/src/server/serve.ts --bind 0.0.0.0 --port "${CIC_WEB_PORT:-8788}" &
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
