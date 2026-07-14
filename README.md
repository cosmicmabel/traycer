# CIC — Command Information Center

[![Apache 2.0 License](https://img.shields.io/badge/License-Apache_2.0-555555.svg?labelColor=333333&color=666666)](./LICENSE)

**CIC is local-only software for orchestrating AI coding agents from your
browser.** It runs entirely on your own machine: no accounts, no sign-in, no
telemetry, no cloud. Agent turns are driven through a local
[OpenClaw Gateway](https://openclaw.ai), so even the AI side is under your
control.

Organize work into **Epics** (boards of chats, artifacts, and terminals),
run agents against real git worktrees with setup scripts, review diffs, and
drive everything from a web GUI served on `127.0.0.1`.

## Quick start

```sh
git clone https://github.com/cosmicmabel/traycer.git cic && cd cic
bun install

make host &        # the host server (loopback WebSocket, writes ~/.cic)
make serve-web     # build + serve the GUI at http://127.0.0.1:8788
```

Open `http://127.0.0.1:8788` — no sign-in, the epic list loads immediately.
Chat turns additionally need an OpenClaw Gateway running locally (default
`ws://127.0.0.1:18789`); the provider row in Settings shows its status.

Full install/configure/verify steps (written for agents and humans):
[`docs/AGENT_SETUP.md`](docs/AGENT_SETUP.md).

## What's inside

| Path               | Package          | Responsibility                                                                          |
| ------------------ | ---------------- | --------------------------------------------------------------------------------------- |
| `protocol/`        | `@cic/protocol`  | Versioned, runtime-negotiated client⇄host wire contract.                                |
| `clients/shared/`  | `@cic/shared`    | Transport (WebSocket/RPC) and platform contracts shared by clients.                     |
| `clients/gui-app/` | `@cic/gui-app`   | The GUI (React + Vite + TanStack Router/Query + Zustand + shadcn/ui).                   |
| `clients/web/`     | `@cic/web`       | Browser shell + Bun serve process — the GUI as a webapp.                                |
| `host/`            | `@cic/open-host` | The host server: chats, epics, terminals, git, worktrees over a local OpenClaw Gateway. |

## Features

- **Epics**: structured boards for multi-step work — chats, plan/spec
  artifacts with collaborative editing, comments, and task tracking.
- **Real terminals**: PTY-backed terminal tiles running on the host machine.
- **Git-native**: per-epic worktrees with setup scripts, live status, and
  staged/unstaged diff review.
- **Agent orchestration**: queue sends during running turns, approvals for
  tool use, agent-to-agent mentions.
- **Local-only by design**: the host binds `127.0.0.1`; remote access goes
  through the web server's proxy on your terms (`--bind 0.0.0.0` for a
  trusted LAN, or your own TLS reverse proxy). The stack makes **zero**
  outbound connections — the only network dependency is whatever your
  OpenClaw Gateway needs for its models.

## Docker

```sh
make docker-web
# equivalent to:
docker build -t cic-web .
docker run --rm -p 8788:8788 -v cic-home:/root/.cic cic-web
```

One container runs the host server and the web GUI; point it at your
gateway with `-e CIC_OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789`.

## Privacy

There is nothing to disclose: CIC stores everything under `~/.cic` on your
machine, sends nothing anywhere, and contains no analytics or crash
reporting. Delete `~/.cic` and it's gone.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits are signed off under the
[Developer Certificate of Origin](CONTRIBUTING.md#developer-certificate-of-origin-dco).
Security issues: see [SECURITY.md](SECURITY.md).

## License and provenance

Licensed under the [Apache 2.0 License](LICENSE). CIC began as a fork of
the open-source client/protocol codebase of Traycer (see [NOTICE](NOTICE))
and has since removed the cloud service integration to become standalone,
local-only software. CIC is an independent project with no affiliation to,
or endorsement by, the upstream authors.
