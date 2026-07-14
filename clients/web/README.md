# @cic/web

Browser shell + serve process that hosts the CIC GUI (`clients/gui-app`)
as a **webapp on a machine running the CIC host server**
([`@cic/open-host`](../../host/README.md)). Full install/configure/verify
steps: [`docs/AGENT_SETUP.md`](../../docs/AGENT_SETUP.md).

## How it works

- `src/shell/` is the browser shell: a Vite build of the shell-agnostic
  `<CICApp />` plus a `BrowserRunnerHost` that implements the `IRunnerHost`
  platform contract with browser storage and a host snapshot stream polled
  from `/api/runtime-config`.
- **There is no sign-in.** CIC is local-only: before the app renders, the
  shell seeds a constant local credential and answers every auth call with
  a synthetic local identity (`src/shell/local-session.ts`). No account, no
  auth service, no outbound requests.
- `src/server/serve.ts` is a Bun process that serves the built bundle and
  bridges the browser to the machine:
  - `/host/rpc` + `/host/stream` — WebSocket proxy to the local host's
    loopback endpoints (from `~/.cic/host[/…]/pid.json`). The host binds
    `127.0.0.1` only; this proxy is what makes it reachable from a browser
    on another machine.
  - `/api/runtime-config` — the current host snapshot.
  - everything else — static bundle with SPA fallback.

## Run it

```bash
# the host server on this machine
bun host/src/index.ts --port 47100 &

# build + serve the GUI (from the repo root)
make serve-web                                            # http://127.0.0.1:8788
make serve-web ARGS="--bind 0.0.0.0 --port 8788"          # expose on a trusted LAN
```

Flags: `--port` (default `8788`), `--bind` (default `127.0.0.1`),
`--environment` (default `production`; picks the pid.json slot),
`--dist` (default `clients/web/dist`).

### Docker

```bash
make docker-web
# equivalent to:
docker build -t cic-web .
docker run --rm -p 8788:8788 -v cic-home:/root/.cic cic-web
```

The entrypoint runs the host server and this web server in one container;
point the host at your gateway with
`-e CIC_OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789`.

## Security

The serve port is an **unauthenticated door to the local CIC host**: there
are no accounts, so anyone who can reach the port gets the page and the
proxy. It binds `127.0.0.1` by default; `--bind 0.0.0.0` is an explicit
opt-in for trusted networks (or front it with your own TLS + auth reverse
proxy).

## Keep in sync

`vite.config.ts` runs the TanStack Router codegen against
`gui-app/src/routeTree.gen.ts` — don't run a second dev server against the
same gui-app tree concurrently.
