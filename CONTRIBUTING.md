# Contributing to CIC

Thanks for helping improve CIC — local-only agent-orchestration software.

## Prerequisites

- **Bun 1.3.12** — the `packageManager` is pinned; install from <https://bun.sh>
- **Node 24**

## Setup

```sh
git clone https://github.com/cosmicmabel/traycer.git cic
cd cic
bun install
```

## Common tasks

| Command                   | What it does                              |
| ------------------------- | ----------------------------------------- |
| `bun run build`           | Build all packages (Nx)                   |
| `bun run compile`         | Type-check every package                  |
| `bun run test`            | Run tests (Vitest)                        |
| `bun run lint`            | Lint (ESLint)                             |
| `bun run format`          | Format (Prettier)                         |
| `cd host && bun test src` | The host server's wire tests (Bun runner) |

Nx caches and only rebuilds what changed. To target one package:

```sh
bunx nx run @cic/web:build
```

## Repo layout

| Path               | Package                                        |
| ------------------ | ---------------------------------------------- |
| `protocol/`        | `@cic/protocol` — client⇄host wire contract    |
| `clients/shared/`  | `@cic/shared` — transport / platform contracts |
| `clients/gui-app/` | `@cic/gui-app` — the GUI (React)               |
| `clients/web/`     | `@cic/web` — browser shell + serve process     |
| `host/`            | `@cic/open-host` — the host server             |

## Pre-commit hooks

We use [pre-commit](https://pre-commit.com) for hygiene checks (whitespace, large files, private keys, YAML/JSON, shell scripts). Install once:

```sh
pipx install pre-commit   # or: brew install pre-commit
pre-commit install --hook-type pre-commit --hook-type commit-msg
```

The hooks then run on every commit; run them on demand with `pre-commit run --all-files`. Lint and format are enforced separately in CI.

## Pull requests

1. Fork and branch from `main`.
2. Keep changes focused; add or update tests where it makes sense.
3. Make sure `bun run build`, `bun run lint`, `bun run test`, and formatting all pass — CI runs the same checks.
4. Open a PR with the template and link any related issue.

## Developer Certificate of Origin (DCO)

Every commit must be **signed off** — it certifies you wrote the patch or have the right to submit it under Apache-2.0. Use `-s`:

```sh
git commit -s -m "your message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. See <https://developercertificate.org/>. PRs whose commits aren't signed off will be asked to amend.

## License

By contributing, you agree your contributions are licensed under [Apache-2.0](LICENSE).
