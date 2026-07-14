# @traycer-clients/web

Browser shell + serve process that hosts the Traycer GUI (`clients/gui-app`)
as a **webapp on a Linux machine running the Traycer host** — no Electron.
Works with the signed host binary or the fully open-source
[`@traycer/open-host`](../../host/README.md). Full install/configure/verify
steps: [`docs/AGENT_SETUP.md`](../../docs/AGENT_SETUP.md).

## How it works

- `src/shell/` is the browser shell: a Vite build of the shell-agnostic
  `<TraycerApp />` (mirroring `clients/desktop/vite.renderer.config.ts`) plus a
  `BrowserRunnerHost` that implements the `IRunnerHost` platform contract with
  in-page auth (device flow via the same-origin `/authn/*` proxy), browser
  token storage, and a host snapshot stream polled from
  `/api/runtime-config`.
- **Local mode (no Traycer login).** When the serve process fronts the
  open-source host (`host/`, pid.json version `0.0.0-open`) — or is started
  with `--local` — `/api/runtime-config` reports `localMode: true` and the
  shell skips Traycer auth entirely: it seeds a constant local credential
  before rendering and answers every validate/refresh with a synthetic
  local identity (`src/shell/local-session.ts`). No account, no network
  auth. `--cloud-auth` forces the sign-in flow back on (for an open host
  started with `--require-auth`).
- `src/server/serve.ts` is a Bun process that serves the built bundle and
  bridges the browser to the machine:
  - `/host/rpc` + `/host/stream` — WebSocket proxy to the local host's
    loopback endpoints (from `~/.traycer/host[/…]/pid.json`). The host binds
    `127.0.0.1` only; this proxy is what makes it reachable from a browser on
    another machine.
  - `/authn/*` — reverse proxy to the Traycer authn service (the authn
    endpoints don't allow arbitrary browser origins).
  - `/api/runtime-config` — sign-in config + the current host snapshot.
  - everything else — static bundle with SPA fallback.

## Run it

```bash
# once: provision + start the signed host release on this machine
bun clients/traycer-cli/src/index.ts host install latest
bun clients/traycer-cli/src/index.ts host start &        # or register the systemd service

# build + serve the GUI (from the repo root)
make serve-web                                            # http://127.0.0.1:8788
make serve-web ARGS="--bind 0.0.0.0 --port 8788"          # expose on a trusted LAN
```

Flags: `--port` (default `8788`), `--bind` (default `127.0.0.1`),
`--environment` (default `production`; picks the pid.json slot),
`--dist` (default `clients/web/dist`), `--sign-in-url`, `--authn-url`,
`--local` / `--cloud-auth` (force local mode on/off; auto-detected from the
fronted host otherwise).

### Docker

```bash
make docker-web
# equivalent to:
docker build -t traycer-web .
docker run --rm -p 8788:8788 -v traycer-home:/root/.traycer traycer-web
```

The entrypoint provisions the signed host release (`host ensure
--no-service-register`, minisign-verified against the trust key in
`clients/traycer-cli/src/config.ts`), runs the host supervisor in the
foreground of the container (no systemd needed), and starts this server on
`0.0.0.0:8788`. Pin a host release with `-e TRAYCER_HOST_VERSION=1.2.3`.

## Security

The serve port is an **unauthenticated door to the local Traycer host**: host
RPCs still authenticate the signed-in user's bearer, but anyone who can reach
the port gets the page and the proxy. It binds `127.0.0.1` by default;
`--bind 0.0.0.0` is an explicit opt-in for trusted networks. Auth tokens are
kept in `localStorage` (plaintext, origin-scoped).

## Keep in sync

`vite.config.ts` mirrors `clients/desktop/vite.renderer.config.ts` and both
run the TanStack Router codegen against the same
`gui-app/src/routeTree.gen.ts` — keep the router-plugin options byte-identical
and don't run the desktop and web dev servers concurrently.
