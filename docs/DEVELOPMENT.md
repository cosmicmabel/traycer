# Development guide

Deeper notes for working on CIC — the protocol, the clients, and the host
server.

## Toolchain

- **Bun 1.3.12** — pinned via `packageManager`
- **Node 24**
- **Nx** runs the workspace targets (`build` / `compile` / `lint` / `test` / `format`) with caching

```sh
bun install
bun run build           # all packages
bunx nx run @cic/protocol:build   # a single package
```

## Pre-commit hooks

Install the hygiene hooks once with `pipx install pre-commit && pre-commit install --hook-type pre-commit --hook-type commit-msg`; they then run on every commit (`pre-commit run --all-files` to run manually). The `commit-msg` hook type is required for DCO sign-off enforcement. Lint and format are enforced in CI.

## Workspace layout

| Path               | Package          | Responsibility                                                                                |
| ------------------ | ---------------- | --------------------------------------------------------------------------------------------- |
| `protocol/`        | `@cic/protocol`  | The versioned client⇄host wire contract (schemas, RPC, framework versioning).                 |
| `clients/shared/`  | `@cic/shared`    | Transport (WebSocket/RPC) and platform contracts shared by clients.                           |
| `clients/gui-app/` | `@cic/gui-app`   | The GUI renderer (React).                                                                     |
| `clients/web/`     | `@cic/web`       | Browser shell + Bun serve process — the GUI as a webapp ([README](../clients/web/README.md)). |
| `host/`            | `@cic/open-host` | The host server ([README](../host/README.md)).                                                |

## Protocol versioning

`@cic/protocol` defines the contract with **per-method `{ major, minor }` versioning negotiated at runtime** (not npm semver). Because the handshake negotiates compatibility, the GUI and the host can evolve independently as long as their versions remain compatible. When you change a method's schema, add a new minor (additive) or major (breaking) version with the appropriate upgrade/downgrade bridges — the registry tests enforce the shape.

## Running the stack

```sh
bun host/src/index.ts --port 47100    # host server: writes ~/.cic/host/pid.json
make serve-web                        # web GUI at http://127.0.0.1:8788
```

The host binds `127.0.0.1` only and the web server discovers it through
`pid.json`. There are no accounts and no external services; agent turns go
through a local OpenClaw Gateway (`--openclaw-gateway-url`, default
`ws://127.0.0.1:18789`). Run the host's wire tests with
`cd host && bun test src` (Bun runtime, not vitest — the server is built on
`Bun.serve`; always use a unique `--environment` per run because persistence
is real). Install/operate steps live in [`AGENT_SETUP.md`](AGENT_SETUP.md).
