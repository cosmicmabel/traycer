- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.

## Operating Context

Use runtime-provided startup context first. Do not manually reread workspace
startup files unless the user asks, the provided context is missing something
needed, or a deeper follow-up read is required.

This project belongs to Mabel and may touch private local systems. Keep secrets
private, verify mutable state before reporting it, and ask before
public/external/destructive actions unless Mabel explicitly authorized the
action.

## Mabel Task Delegation Rule

For any request or task from Mabel, quickly estimate whether Guppi's work will
take more than 30 seconds. If it should take 30 seconds or less, handle it
locally. If it should take more than 30 seconds, spawn or delegate by default so
the main assistant stays available for replies, updates, interrupts, and
decisions.

Guppi's default role is executive assistant/coordinator, not primary doer:
clarify the desired outcome, break work into bounded packets, delegate where
sensible, track status, and synthesize results. Execute directly only for
quick/trivial work, explicit requests, worker supervision, or urgent system
safety.

## Sandbox-First Safety Rule

For Guppi/OpenClaw runtime, config, plugin, dependency, voice, channel, gateway,
or service lifecycle changes: test in Sandbox Guppi first unless there is an
active production outage where sandbox cannot help. Use
`/root/.openclaw/workspace/tools/guppi-sandbox/guppi-sandbox smoke` at minimum,
plus the feature-specific check, before applying to live Guppi.

For config or gateway restart changes, create or schedule a 5-minute
disaster-recovery rollback/recovery guard before touching live state. Never use
live Guppi as the first test surface for major changes. Record any exception and
why it was unavoidable.

## Red Lines

- Do not exfiltrate private data.
- Do not run destructive commands without asking.
- Prefer recoverable deletion such as `trash` over permanent removal.
- When in doubt, ask.

## Skill Security Rule

All third-party skills must be vetted with `skill-vetter` before installation.

- Review all files, not just `SKILL.md`.
- Check for outbound network calls, sensitive file access, obfuscated code,
  `eval`/dynamic exec, credential requests, dependency/install scripts, elevated
  permissions, and broad workspace/system writes.
- Produce a short vetting report with source, files reviewed, red flags,
  permission scope, risk level, and verdict.
- High-risk or destructive/security-policy-changing skills require Mabel's
  explicit approval.
- Skills that fail vetting must not be installed.

## Documentation

Durable documentation Guppi writes or maintains should be mirrored to
`docs.mabel.gg` as sanitized, operationally useful extracts. Do not mirror raw
private workspace files, secrets, private channel/user IDs, credential values, or
unnecessary private memory. Include the final docs link when docs are published
or updated.

## Project Overview

CIC (Command Information Center) is **local-only software for orchestrating
AI coding agents from a browser**: no accounts, no telemetry, no cloud. The
whole product lives in this repo — a host server driving agent turns through
a local OpenClaw Gateway, plus a web GUI. It uses **Bun workspaces** and
**Nx** for task orchestration. Operating instructions:
[`docs/AGENT_SETUP.md`](docs/AGENT_SETUP.md).

### Workspaces

| Path               | Package          | Responsibility                                                             |
| ------------------ | ---------------- | -------------------------------------------------------------------------- |
| `protocol/`        | `@cic/protocol`  | Versioned, runtime-negotiated client⇄host wire contract (schemas, RPC).    |
| `clients/shared/`  | `@cic/shared`    | Transport (WebSocket/RPC) and platform contracts shared across clients.    |
| `clients/gui-app/` | `@cic/gui-app`   | GUI renderer (React + Vite + TanStack Router/Query + Zustand + shadcn/ui). |
| `clients/web/`     | `@cic/web`       | Browser shell + Bun serve process — the GUI as a webapp on Linux.          |
| `host/`            | `@cic/open-host` | The host server (wire contract over a local OpenClaw Gateway).             |

### Workspace-Specific Agent Docs

- `clients/gui-app/` — read [`clients/gui-app/AGENTS.md`](clients/gui-app/AGENTS.md)
  before app-specific changes; it lists the GUI-focused skills in
  `.agents/skills/` to prefer there.
- `host/` — read [`host/README.md`](host/README.md) before host changes; its
  tests run under `bun test` (from `host/`), NOT vitest, and each test run
  must use a unique `--environment` because persistence is real.

## Common Commands

```bash
bun install
bun run build      # build the publishable packages (Nx)
bun run compile    # type-check every package
bun run test       # Vitest
bun run lint       # ESLint
bun run format     # Prettier

pre-commit run --all-files   # hygiene + workspace checks
```

Nx caches and only rebuilds what changed. Target a single package with e.g.
`bunx nx run @cic/web:build`.

### Running the stack locally

```bash
make host &        # the host server (loopback WS, writes ~/.cic)
make serve-web     # build + serve the GUI at http://127.0.0.1:8788
```

No accounts and no external services; chat turns need a local OpenClaw
Gateway (`ws://127.0.0.1:18789`). See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Architecture

### Protocol

`@cic/protocol` is the **versioned, runtime-negotiated** client⇄host wire
contract — per-method `{ major, minor }` compatibility negotiated at the
handshake, not npm semver. Clients and the host can ship independently as long
as their versions stay compatible.

### Host identity model

Two domain rules govern how the renderer addresses hosts:

1. **`hostId` ≡ `deviceId`.** The same identifier names a physical machine and the
   host process running on it. `hostId` is canonical in code and schemas;
   "device" is UI-only copy. Don't introduce a parallel `deviceId` field that
   maps 1:1 to an existing `hostId`.

2. **Tabs are bound to a host for life.** Every chat tab and every terminal tab
   carries a `hostId` persisted in its artifact schema. The React tree projects
   this with `<TabHostProvider hostId>`; consumers read `useTabHostId()` from
   context, never `useReactiveActiveHostId()`. Cross-host continuation is
   **clone-not-migrate**:
   - **Chat**: continuing on a different host clones the artifact (new id, copied
     history).
   - **Terminal**: bound for life — a PTY can't migrate. If the host is
     unreachable, the tab is permanently dead until that host returns.

   Reachability is checked **at tab-open time only**, not reactively. There is no
   "swap host" affordance.

The renderer addresses **two host scopes** simultaneously:

- **Default host**: machine-local host for app-wide features (Epic list, opening
  artifacts, notifications, host-status footer). Accessed via
  `useReactiveActiveHostId()` / `useHostClient()`.
- **Tab-scoped host**: per-tab binding from the artifact schema. Accessed via
  `useTabHostId()` from `<TabHostProvider>`.

When adding a query/mutation hook, decide explicitly which scope it serves. Don't
write a hook that silently switches scopes based on render context.

## Skills Usage

When working in a workspace, search its `.agents/` or `.claude/` folder for
relevant skills and use them for the task at hand. The GUI workspace
(`clients/gui-app/`) ships local skills (shadcn, Tailwind v4, TanStack
Router/Query, Zustand) — see its `AGENTS.md`.

## Style Guide

- Keep things in one function unless composable or reusable.
- Avoid `try`/`catch` except at boundaries where you can handle or add context.
- Avoid the `any` type.
- Rely on type inference; avoid explicit annotations/interfaces unless needed for
  exports or clarity.
- Prefer functional array methods (`flatMap`, `filter`, `map`) over for-loops; use
  type guards on `filter` to keep type inference downstream.

## Code Guidelines

- **Naming**: files `kebab-case`, classes/types `PascalCase`, functions
  `camelCase`, constants `UPPER_SNAKE_CASE`.
- **Strict typing**: avoid `any` and unsafe assertions. Do not use `as any`,
  `as unknown`, or chained assertions like `as unknown as`.
- **Function signatures**: do not use optional parameters (`?:`). Use explicit
  unions such as `value: T | undefined` or `value: T | null`.
- **Required arguments**: do not use default parameter values; every argument is
  passed explicitly by the caller.
- **No pseudo-optionals**: do not use rest-parameter tuple/union shims such as
  `...args: [value: T | undefined]`.
- **Explicit types**: do not use utility aliases like `ReturnType<...>` to infer
  another function's return type; define the concrete type directly.
- **Lint policy**: these type-safety rules apply to production code and tests. Do
  not bypass them with `eslint-disable` / `eslint-ignore` or equivalent
  suppressions.
- **Shared code**: put transport/auth/formatting shared across clients in
  `clients/shared/`, and the client⇄host wire contract in `protocol/`. Don't
  duplicate.
- **Error handling**: catch only at boundaries where you can handle or add
  context.
- **Logging**: log at task/transport boundaries. Never log secrets or user code.
  Don't "log + rethrow" deep in the stack.
- **Sizing (UI)**: no fixed pixel/rem widths or heights for layout surfaces. Use
  fluid constraints — `w-full`, `max-w-*`, `min-h-*`, `max-h-*`, `%`,
  `vw`/`vh`/`dvh`, `clamp()`, `min()`, `max()`, flex/grid sizing. For
  popovers/dialogs/sheets cap with viewport-aware values like `w-[min(90vw,Nrem)]`,
  `max-h-[min(70vh,Nrem)]`. Hardcoded sizes only for inherently fixed elements:
  icons, hairlines, badges, touch targets.

## Type Checking

- Always run `bun run compile` for the workspaces containing your changes, never
  `tsc` directly.
