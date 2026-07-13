# Agent setup guide

This document is written for **AI agents** (and automation) installing,
configuring, and verifying this fork of Traycer on a Linux machine. Every
step is a copy-pasteable command with an explicit verification probe.
Humans are welcome too; the prose is just deliberately unambiguous.

What this fork adds on top of upstream Traycer (see the
[root README](../README.md#this-fork)):

1. **OpenClaw as an agent harness** — wired through the versioned protocol
   and the GUI.
2. **Web hosting on Linux** — `clients/web/`: a browser shell + Bun serve
   process (+ Dockerfile), instead of the Electron desktop.
3. **`@traycer/open-host`** — an open-source host server (`host/`)
   implementing the client⇄host wire contract, so the whole stack runs
   without the closed-source host binary. It drives agent turns through a
   local [OpenClaw Gateway](https://docs.openclaw.ai).

## 0. Pick a deployment mode

| Mode                                 | Host process                                   | Use when                                                                            |
| ------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| **A. Fully open (recommended here)** | `@traycer/open-host` (`bun host/src/index.ts`) | You want no closed-source components. Agent turns run via a local OpenClaw Gateway. |
| **B. Signed host**                   | Official host binary provisioned by the CLI    | You want the full upstream feature set (Traycer cloud, all providers).              |
| **C. Docker**                        | Signed host inside a container                 | One-command self-hosting; wraps mode B.                                             |

All three serve the GUI at `http://127.0.0.1:8788` through the same web
server. Modes A and B differ only in which process writes
`~/.traycer/host/pid.json`.

## 1. Prerequisites

| Requirement                    | Check                   | Notes                                                                                                          |
| ------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Linux (or macOS)               | `uname -s`              | The web server and open host are developed against Linux.                                                      |
| Bun ≥ 1.3                      | `bun --version`         | Install: `curl -fsSL https://bun.sh/install \| bash`. Bun ≥ 1.3 is required for the open host's PTY terminals. |
| git                            | `git --version`         | Used by the open host for diff/status/worktree features.                                                       |
| Docker (mode C only)           | `docker --version`      |                                                                                                                |
| OpenClaw Gateway (mode A only) | `nc -z 127.0.0.1 18789` | The gateway's WS control plane; default `ws://127.0.0.1:18789`. Chat turns need it; the GUI boots without it.  |

```sh
git clone https://github.com/cosmicmabel/traycer.git
cd traycer
bun install          # workspace install (Bun workspaces + Nx)
```

Verify the toolchain end to end (all must exit 0):

```sh
bun run compile      # type-checks every package
cd host && bun test src && cd ..   # the open host's wire-level test suite
```

## 2. Mode A — open host + web shell

### 2.1 Start the open host

```sh
bun host/src/index.ts --port 47100
```

Expected stdout:
`open host 0.0.0-open listening on ws://127.0.0.1:47100/rpc (hostId …, pid file /home/<user>/.traycer/host/pid.json)`

All flags (defaults in parentheses):

| Flag                             | Default                    | Meaning                                                                                                                                                        |
| -------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port N`                       | `0` (OS-assigned)          | WS server port. Pass a fixed port for reproducible setups.                                                                                                     |
| `--environment NAME`             | `production`               | pid.json slot: `production` → `~/.traycer/host/`, anything else → `~/.traycer/host/<NAME>/`. The web server must be started with the **same** `--environment`. |
| `--authn-url URL`                | `https://authn.traycer.ai` | Authn service used to verify client bearer tokens.                                                                                                             |
| `--insecure-no-auth`             | off                        | Accept ANY non-empty bearer without verification. **Offline development only** — never on a reachable port.                                                    |
| `--openclaw-gateway-url URL`     | `ws://127.0.0.1:18789`     | The local OpenClaw Gateway control plane.                                                                                                                      |
| `--openclaw-gateway-token TOKEN` | none                       | Shared-secret token for the gateway `connect` handshake, if the gateway requires one.                                                                          |

Verify (the only plain-HTTP endpoint is the unauthenticated activity probe):

```sh
curl -s http://127.0.0.1:47100/activity      # → {"busy":false}
cat ~/.traycer/host/pid.json                 # → hostId/version/websocket url
```

Run it as a service (systemd example):

```ini
# /etc/systemd/system/traycer-open-host.service
[Unit]
Description=Traycer open host
After=network.target
[Service]
ExecStart=/usr/bin/env bun /opt/traycer/host/src/index.ts --port 47100
Restart=on-failure
User=traycer
[Install]
WantedBy=multi-user.target
```

### 2.2 Start the web shell

```sh
make serve-web                                       # builds clients/web + serves
# or directly:
bunx nx run @traycer-clients/web:build
bun clients/web/src/server/serve.ts                  # http://127.0.0.1:8788
```

Web server flags:

| Flag                 | Default            | Meaning                                                                                                                  |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `--port N`           | `8788`             | HTTP port.                                                                                                               |
| `--bind ADDR`        | `127.0.0.1`        | Bind address. `0.0.0.0` exposes the GUI (and the host proxy) to the network — explicit opt-in for trusted networks only. |
| `--environment NAME` | `production`       | Which pid.json slot to proxy to. Match the host's `--environment`.                                                       |
| `--dist PATH`        | `clients/web/dist` | Built bundle location.                                                                                                   |
| `--sign-in-url URL`  | production sign-in | Overrides the sign-in link shown before auth.                                                                            |
| `--authn-url URL`    | production authn   | Upstream for the `/authn/*` reverse proxy.                                                                               |

Verify:

```sh
curl -s http://127.0.0.1:8788/api/runtime-config
# → JSON with "host": { "hostId": …, "websocketUrl": "…/host/rpc", … } — "host" must be non-null.
```

Open `http://127.0.0.1:8788` in a browser, sign in (device flow), and the
epic list should load. Chat turns additionally require the OpenClaw
Gateway to be reachable (the provider row in Settings shows its status).

### 2.3 Configure the OpenClaw Gateway

The open host is a protocol adapter: model/tool selection, agent auth, and
session storage belong to the gateway. Point the host at it with
`--openclaw-gateway-url` (and `--openclaw-gateway-token` if configured).
Reachability is probed with a connect handshake and cached ~15 s; the
`openclaw` provider/harness rows in the GUI flip to available when the
probe succeeds. Chat sessions map 1:1 to gateway sessions keyed
`traycer-<chatId>`.

## 3. Mode B — signed host + web shell

```sh
bun clients/traycer-cli/src/index.ts host install latest   # download + minisign-verify
bun clients/traycer-cli/src/index.ts host start &          # foreground supervisor (or systemd)
make serve-web
```

The CLI verifies the host archive against the trust key committed in
`clients/traycer-cli/src/config.ts`; no secrets are needed. Verification is
identical to mode A (`/api/runtime-config` must report a non-null host).

## 4. Mode C — Docker

```sh
make docker-web
# equivalent to:
docker build -t traycer-web .
docker run --rm -p 8788:8788 -v traycer-home:/root/.traycer traycer-web
```

The entrypoint (`docker/entrypoint.sh`) provisions the signed host
(`host ensure --no-service-register`), starts the host supervisor, then the
web server on `0.0.0.0:8788`. Pin a host release with
`-e TRAYCER_HOST_VERSION=1.2.3`. The `traycer-home` volume persists auth,
host installs, and user data across container restarts; `docker stop` shuts
the host down gracefully.

## 5. On-disk layout (open host)

Everything lives under the host home —
`~/.traycer/host/` for `--environment production`, else
`~/.traycer/host/<env>/`:

| Path                                   | Contents                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pid.json`                             | Discovery contract: hostId, version, loopback WS URL. Written on start, removed on SIGTERM/SIGINT. |
| `open-host-id.json`                    | The stable hostId (minted once).                                                                   |
| `open-host-chats/`                     | Chat transcripts (one JSON per epic/chat, canonical `chatSchema`).                                 |
| `open-host-epics/`                     | Epic Y.Doc blobs (root + artifact rooms, `.yupdate`).                                              |
| `open-host-tasks.json`                 | The epic/task index behind `epic.listTasks`.                                                       |
| `open-host-comments.json`              | Artifact comment threads.                                                                          |
| `open-host-worktree-bindings.json`     | Per-owner worktree bindings.                                                                       |
| `open-host-worktrees/<repo>/<branch>/` | Worktrees created by `worktree.create`.                                                            |
| `open-host-epic-cwd/<epicId>/`         | Fallback cwd minted for folderless epics' terminals.                                               |
| `open-host-provider-settings.json`     | Provider settings (enabled flags, env overrides, stored API keys — plaintext).                     |
| `open-host-selection-guide.md`         | The global agent selection guide.                                                                  |
| `open-host-notifications/`             | Per-user notification Y.Docs.                                                                      |

Deleting the host home resets the open host completely (it is recreated on
next start). Test environments always use a unique `--environment`, so they
never touch production data.

## 6. Security model (read before exposing anything)

- The **open host binds `127.0.0.1` only** — that is part of the pid.json
  contract clients verify. Remote access goes through the web server's
  proxy, never by rebinding the host.
- The **web serve port is an unauthenticated door** to the page and the
  host proxy; host RPCs still verify the signed-in user's bearer against
  authn, but treat `--bind 0.0.0.0` as trusted-network-only (or front it
  with your own TLS + auth reverse proxy).
- `--insecure-no-auth` disables bearer verification entirely. Offline
  development only.
- Browser tokens are stored in `localStorage` (plaintext, origin-scoped);
  provider API keys saved through Settings are stored plaintext in
  `open-host-provider-settings.json`.

## 7. Troubleshooting

| Symptom                                                 | Likely cause                                      | Fix                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/api/runtime-config` returns `"host": null`            | No pid.json in the selected slot                  | Start the host; make `--environment` match on both processes.                                  |
| GUI loads but sign-in fails                             | Authn unreachable through the proxy               | Check outbound HTTPS from the serving machine; override `--authn-url` if self-hosting authn.   |
| `openclaw` provider shows "Start the OpenClaw Gateway…" | Gateway probe failing                             | Start the gateway; verify `--openclaw-gateway-url`/token. Availability re-probes within ~15 s. |
| Chat send errors with `OPENCLAW_GATEWAY_ERROR`          | Gateway reachable at boot but connect/send failed | Check gateway logs; the turn error text carries the underlying message.                        |
| `UNAUTHORIZED` fatal frames on connect                  | Bearer rejected by authn                          | Re-sign-in; for offline work use `--insecure-no-auth` (dev only).                              |
| Web build fails on `routeTree.gen.ts`                   | Desktop + web dev servers ran concurrently        | They share TanStack Router codegen; run one at a time, then rebuild.                           |
| Terminals never echo                                    | Bun < 1.3 (no PTY support)                        | Upgrade Bun (`bun upgrade`), restart the host.                                                 |

## 8. Verification checklist

Run after any install or upgrade; every command must succeed:

```sh
bun run compile                                   # repo-wide type-check
cd host && bun test src && cd ..                  # 48 wire tests against a live server
curl -s http://127.0.0.1:47100/activity           # {"busy":false}   (host up)
curl -s http://127.0.0.1:8788/api/runtime-config  # "host" non-null  (proxy wired)
```

## 9. Further reading

- [`host/README.md`](../host/README.md) — the open host's full implemented
  surface, wire-contract notes, and remaining gaps.
- [`clients/web/README.md`](../clients/web/README.md) — web shell/server
  internals and security notes.
- [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) — toolchain, workspace layout,
  protocol versioning.
- Repo-root [`AGENTS.md`](../AGENTS.md) / [`CLAUDE.md`](../CLAUDE.md) —
  conventions for agents **modifying** this codebase (this file is about
  **operating** it).
