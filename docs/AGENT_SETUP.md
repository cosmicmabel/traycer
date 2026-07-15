# Agent setup guide

This document is written for **AI agents** (and automation) installing,
configuring, and verifying CIC on a Linux machine. Every step is a
copy-pasteable command with an explicit verification probe. Humans are
welcome too; the prose is just deliberately unambiguous.

CIC is **local-only software**: two processes on one machine, no accounts,
no telemetry, no outbound connections.

1. **The host server** (`host/`, `@cic/open-host`) — chats, epics, PTY
   terminals, git/worktrees. It drives agent turns through a local
   [OpenClaw Gateway](https://docs.openclaw.ai).
2. **The web server** (`clients/web/`, `@cic/web`) — serves the GUI bundle
   and proxies the browser to the host.

## 1. Prerequisites

| Requirement      | Check                   | Notes                                                                                                         |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| Linux (or macOS) | `uname -s`              | The stack is developed against Linux.                                                                         |
| Bun ≥ 1.3        | `bun --version`         | Install: `curl -fsSL https://bun.sh/install \| bash`. Bun ≥ 1.3 is required for the host's PTY terminals.     |
| git              | `git --version`         | Used by the host for diff/status/worktree features.                                                           |
| Docker (only §4) | `docker --version`      |                                                                                                               |
| OpenClaw Gateway | `nc -z 127.0.0.1 18789` | The gateway's WS control plane; default `ws://127.0.0.1:18789`. Chat turns need it; the GUI boots without it. |

```sh
git clone https://github.com/cosmicmabel/traycer.git cic
cd cic
bun install          # workspace install (Bun workspaces + Nx); needs internet ONCE
```

Verify the toolchain end to end (all must exit 0):

```sh
bun run compile      # type-checks every package
cd host && bun test src && cd ..   # the host's wire-level test suite
```

After `bun install` and the web build, the stack runs with **no internet
access at all** (a LAN for `--bind` deployments is enough).

## 2. Start the host server

```sh
bun host/src/index.ts --port 47100
```

Expected stdout:
`open host 0.0.0-open listening on ws://127.0.0.1:47100/rpc (hostId …, pid file /home/<user>/.cic/host/pid.json)`
followed by `local-only: no accounts, no external services - every connection is the local user.`

All flags (defaults in parentheses):

| Flag                             | Default                | Meaning                                                                                                                                                |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--port N`                       | `0` (OS-assigned)      | WS server port. Pass a fixed port for reproducible setups.                                                                                             |
| `--environment NAME`             | `production`           | pid.json slot: `production` → `~/.cic/host/`, anything else → `~/.cic/host/<NAME>/`. The web server must be started with the **same** `--environment`. |
| `--openclaw-gateway-url URL`     | `ws://127.0.0.1:18789` | The local OpenClaw Gateway control plane.                                                                                                              |
| `--openclaw-gateway-token TOKEN` | none                   | Shared-secret token for the gateway `connect` handshake, if the gateway requires one.                                                                  |

Verify (the only plain-HTTP endpoint is the unauthenticated activity probe):

```sh
curl -s http://127.0.0.1:47100/activity      # → {"busy":false}
cat ~/.cic/host/pid.json                     # → hostId/version/websocket url
```

Run it as a service (systemd example):

```ini
# /etc/systemd/system/cic-host.service
[Unit]
Description=CIC host server
After=network.target
[Service]
ExecStart=/usr/bin/env bun /opt/cic/host/src/index.ts --port 47100
Restart=on-failure
User=cic
[Install]
WantedBy=multi-user.target
```

## 3. Start the web server

```sh
make serve-web                                       # builds clients/web + serves
# or directly:
bunx nx run @cic/web:build
bun clients/web/src/server/serve.ts                  # http://127.0.0.1:8788
```

Web server flags:

| Flag                 | Default            | Meaning                                                                                                                  |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `--port N`           | `8788`             | HTTP port.                                                                                                               |
| `--bind ADDR`        | `127.0.0.1`        | Bind address. `0.0.0.0` exposes the GUI (and the host proxy) to the network — explicit opt-in for trusted networks only. |
| `--environment NAME` | `production`       | Which pid.json slot to proxy to. Match the host's `--environment`.                                                       |
| `--dist PATH`        | `clients/web/dist` | Built bundle location.                                                                                                   |
| `--no-auth`          | off                | Disable the local password gate (below). Only for a pure-loopback machine you fully trust.                               |

**Login.** The serve port is protected by a machine-local password (there is
still no account and no external auth service). On the first visit the page
asks you to **create a password**; later visits ask you to unlock. The
password is argon2id-hashed in `~/.cic/web-auth.json` (mode 0600), sessions
are HttpOnly cookies, and repeated wrong guesses lock out briefly. Forgot it?
Delete `~/.cic/web-auth.json` and reload to set a new one. Pass `--no-auth`
to skip the gate entirely on a trusted loopback host.

Verify:

```sh
curl -s http://127.0.0.1:8788/api/auth/status
# → {"authRequired":true,"passwordSet":false,"authenticated":false} on a fresh install
curl -s http://127.0.0.1:8788/api/runtime-config   # → 401 until you log in (200 with a session cookie)
```

Open `http://127.0.0.1:8788` in a browser, set/enter your password, and the
epic list loads. Chat turns additionally require the selected agent to be
runnable (the provider row in Settings shows its status).

### Agents

CIC runs agent turns two ways, both local:

- **OpenClaw** — through the local OpenClaw Gateway. The host is a protocol
  adapter here: model/tool selection, agent auth, and session storage belong
  to the gateway. Point the host at it with `--openclaw-gateway-url` (and
  `--openclaw-gateway-token` if configured); reachability is probed with a
  connect handshake, cached ~15 s. Sessions map 1:1 to gateway sessions keyed
  `cic-<chatId>`.
- **Claude Code / Codex / Grok** — by spawning the vendor CLI. Install the CLI
  and make sure it's on `PATH` (or set a custom path in Settings → Providers);
  the host detects it via `--version` and the harness flips to available. Sign
  in with the CLI itself (`claude`, `codex`, `grok`) exactly as you would in a
  terminal — the host never sees the vendor credentials. Each turn runs the
  CLI in its non-interactive mode in the epic's working directory and streams
  the reply back.

The Providers panel in Settings shows each agent's detected/enabled state.

## 4. Docker

```sh
make docker-web
# equivalent to:
docker build -t cic-web .
docker run --rm -p 8788:8788 -v cic-home:/root/.cic \
  -e CIC_OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789 cic-web
```

The entrypoint (`docker/entrypoint.sh`) runs the host server and the web
server in one container; the `cic-home` volume persists chats, epics,
worktrees, and settings across restarts, and `docker stop` shuts both down
gracefully.

## 5. On-disk layout

Everything lives under the host home — `~/.cic/host/` for
`--environment production`, else `~/.cic/host/<env>/`:

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

Deleting the host home resets CIC completely (it is recreated on next
start). Test environments always use a unique `--environment`, so they
never touch production data.

## 6. Security model (read before exposing anything)

- The **host binds `127.0.0.1` only** — that is part of the pid.json
  contract clients verify. Remote access goes through the web server's
  proxy, never by rebinding the host.
- The **web serve port is gated by a machine-local password** (unless
  `--no-auth`). That protects the page and the host proxy, but it is one
  shared password, not per-user accounts — treat `--bind 0.0.0.0` as
  trusted-network-only, and front it with your own TLS if the network isn't
  trusted (the session cookie is not marked `Secure` because the server
  speaks plain HTTP). The password is argon2id-hashed in
  `~/.cic/web-auth.json`.
- Provider API keys saved through Settings are stored plaintext in
  `open-host-provider-settings.json`. Vendor CLI logins (Claude/Codex/Grok)
  live wherever each CLI keeps them; the host never reads or proxies them.
- The host stack makes **no outbound connections**. The only network
  dependencies are what your OpenClaw Gateway needs, and whatever the vendor
  CLIs contact when they run.

## 7. Troubleshooting

| Symptom                                                 | Likely cause                                      | Fix                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/api/runtime-config` returns `"host": null`            | No pid.json in the selected slot                  | Start the host; make `--environment` match on both processes.                                  |
| `openclaw` provider shows "Start the OpenClaw Gateway…" | Gateway probe failing                             | Start the gateway; verify `--openclaw-gateway-url`/token. Availability re-probes within ~15 s. |
| Chat send errors with `OPENCLAW_GATEWAY_ERROR`          | Gateway reachable at boot but connect/send failed | Check gateway logs; the turn error text carries the underlying message.                        |
| Web build fails on `routeTree.gen.ts`                   | Stale TanStack Router codegen                     | Re-run the build; don't run two dev servers against the same gui-app tree.                     |
| Terminals never echo                                    | Bun < 1.3 (no PTY support)                        | Upgrade Bun (`bun upgrade`), restart the host.                                                 |

## 8. Verification checklist

Run after any install or upgrade; every command must succeed:

```sh
bun run compile                                   # repo-wide type-check
cd host && bun test src && cd ..                  # wire tests against a live server
curl -s http://127.0.0.1:47100/activity           # {"busy":false}   (host up)
curl -s http://127.0.0.1:8788/api/runtime-config  # "host" non-null  (proxy wired)
```

## 9. Further reading

- [`host/README.md`](../host/README.md) — the host server's full
  implemented surface and wire-contract notes.
- [`clients/web/README.md`](../clients/web/README.md) — web shell/server
  internals and security notes.
- [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) — toolchain, workspace layout,
  protocol versioning.
- Repo-root [`AGENTS.md`](../AGENTS.md) / [`CLAUDE.md`](../CLAUDE.md) —
  conventions for agents **modifying** this codebase (this file is about
  **operating** it).
