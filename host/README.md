# @traycer/open-host

An **open-source Traycer host**: a WebSocket RPC server implementing the
client⇄host wire contract from `@traycer/protocol`, as a self-hostable
replacement for the closed-source host binary. It speaks the exact protocol
the shipped clients speak — frames are parsed and emitted through the
canonical schemas in `protocol/src/framework/ws-protocol.ts` /
`stream-ws-protocol.ts`, and compatibility uses the same oracle
(`checkCompatibility`) both sides share.

## Run it

```bash
bun host/src/index.ts                          # verify bearers against authn.traycer.ai
bun host/src/index.ts --insecure-no-auth       # offline dev: accept any bearer
bun host/src/index.ts --environment dev --port 48765 \
  --openclaw-gateway-url ws://127.0.0.1:18789
```

It binds `127.0.0.1` only (part of the pid.json contract), writes
`~/.traycer/host[/env]/pid.json` so every client (desktop, CLI, the
`clients/web` serve process) discovers it exactly like the closed host, and
removes the pid file on SIGTERM/SIGINT.

## What is implemented

- **Transport, byte-compatible with the shipped clients**
  - `/rpc`: one RPC per socket — `open {token, manifest}` → bearer
    verification (authn `GET /api/v3/user`, cached) + host-side compatibility
    check → `openAck {manifest}` → `request` → `response`; 30s post-open idle
    timeout mirroring the client's frame timeout; `fatalError` frames with
    `UNAUTHORIZED` (+ `retryable: true` for transient authn outages) and
    `INCOMPATIBLE` details.
  - `/stream`: `open` → `openAck {manifest, capabilities}` handshake with the
    stream compatibility oracle, `ping`→`pong` heartbeat.
  - `GET /activity`: the unauthenticated loopback probe
    (`{"busy": false}`).
- **Versioned dispatch over the full `hostRpcRegistry`** — the manifest
  advertises every method at its canonical version (a partial manifest would
  fail the handshake outright); requests arriving at an older installed
  on-wire version are upgraded to canonical through the registry's
  `upgradeFromPreviousVersion` chain, and responses are downgraded back
  (cross-major via `downgradePathsFromLatest`, e.g. a `providers.list@2.0`
  caller never sees the `amp`/`openclaw` rows). Unimplemented methods answer
  a structured `RPC_ERROR` per request instead of failing the connection.
- **Implemented methods**: `host.status`, `host.getRuntimeCapabilities`,
  `providers.list`, `agent.gui.listHarnesses` (advertising **openclaw**,
  availability driven by a live OpenClaw Gateway probe),
  `agent.gui.listModels`, `agent.gui.listCommands`.
- **OpenClaw Gateway client** (`src/openclaw/gateway-client.ts`): the
  `req`/`res`/`event` frame protocol with the `connect` handshake
  (role `operator`, protocol bounds, optional token), a cached reachability
  probe, and `sendChat` (fire a prompt into a gateway session and stream the
  agent's events back) — the seam the `chat.subscribe` session plugs into.

## Roadmap (in dependency order)

1. **`chat.subscribe` stream sessions** backed by the OpenClaw Gateway
   adapter: snapshot on subscribe, `send` → `actionAck`/`messageAccepted`/
   `turnStateChanged`/`blockDelta` runtime events mapped from gateway
   `agent`/`chat` events, with an in-memory (then persisted) chat store.
2. **`epic.subscribe`** Y.Doc sync (yjs is already a dependency) so the GUI's
   epic surfaces work: `snapshot`/`update`/`awareness` binary frames over the
   documented envelope pairing.
3. Epic/workspace unary surfaces, then worktrees/terminals.

Every unimplemented surface degrades per-request/per-subscription; the GUI's
boot gate (`host.status`) and the harness/provider catalogs already work
against this host.

## Tests

`bun test src` (also wired as the workspace `test` script — the server is
built on `Bun.serve`, so tests run under the Bun runtime, not vitest). The
suite dials the running server over real WebSockets and asserts wire-level
behavior: handshake + `host.status`, the openclaw catalog row, cross-major
`providers.list` downgrade, structured errors for unimplemented methods,
`INCOMPATIBLE` fatal frames, the stream handshake, and the activity probe.
