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

- **`chat.subscribe@1.3` sessions backed by the OpenClaw Gateway**
  (`src/chat/chat-session.ts`): snapshot on subscribe (chat record, access,
  queue, run state), `send` → `actionAck` / `messageAccepted` / durable
  `eventAppended` rows / `turnStateChanged` / `blockDelta` runtime events
  (`turn.started`, `text.delta` diffed from the gateway's cumulative
  `chat.*` snapshots, `text.completed`, `turn.completed`), `stop`, and
  ping→pong. Chats are in-memory per host process; a resubscribe replays the
  persisted messages in its snapshot. Unsupported owner actions are
  acknowledged as rejected without dropping the stream.

- **`epic.subscribe@1.0` Y.Doc sync** (`src/epic/epic-store.ts`): one Y.Doc
  per epic root plus per-artifact-room body docs, `snapshot` +
  `cloudSyncStatus` + room snapshots on subscribe, client
  `applyUpdate`/`awareness` (root and room scope) applied and relayed to
  every other subscriber over the documented envelope+binary frame pairing,
  with debounced persistence to `~/.traycer/host[/env]/open-host-epics/` so
  epics survive restarts. `cloudSyncStatus` reports `connected` because the
  local doc IS the authoritative copy — there is no cloud room behind this
  host.

- **Epic unary surface** (`src/epic/task-index.ts` + handlers):
  `epic.create` (including the folded first-chat seed, minted idempotently in
  the chat store and written into the epic Y.Doc's `chats` map so every
  subscriber projects the new chat card), `epic.listTasks` from a local JSON
  task index stored in the canonical `epicLightWithPermission` wire shape,
  and `epic.createChat`. Host-side Y.Doc writes share one broadcast path
  with client pushes via origin-tagged Y update events.

- **Epic/chat mutations + durability**: `epic.updateTitle` (task-index
  delta), `epic.renameChat` (user-pinned titles, re-seeded into the Y.Doc),
  `epic.deleteChat` (live state + blob + Y map entry), and chat transcripts
  persisted per record to `~/.traycer/host[/env]/open-host-chats/`
  (chatSchema-validated on lazy load) so they survive restarts.
- **Tool-call mapping**: gateway tool events (`session.tool`, agent tool
  phases) map onto `tool_call.started/completed/errored` runtime events and
  persist as `tool_call` content blocks ahead of the text block.
- **Task associations + batch delete**: `epic.create` stamps
  `repoIdentifiers`/`workspaces` onto the task row, `epic.batchDelete`
  removes the index row, the epic Y.Doc blobs, and the persisted chat
  transcripts per id (with per-id success results), and
  `epic.listCollaborators` reports `collaboratorsAvailable: false` so the
  GUI hides sharing UI on this single-user host.
- **Chat queueing**: a `send` that arrives while a turn is running (or while
  the queue is paused) is queued instead of rejected — `actionAck` +
  `queueChanged` + a durable `queue.added` event — and drained one send per
  turn boundary from `finishTurn`. `pauseQueue` / `resumeQueue` /
  `queueCancel` are implemented; `queueEdit`/`queueReorder`/`queueSteerNow`
  still answer rejected acks.

- **Workspace surface** (`src/workspace/workspace-service.ts`): local
  filesystem + git behind `workspace.prepareFolders` (origin remote →
  `{owner, repo}` identifier), `workspace.listFileTree` (`git ls-files` with
  the user's own ignore rules, porcelain git status, `maxFiles` truncation),
  `workspace.listDirectory`, `workspace.readFile` (byte-capped, rejects
  paths escaping the root), the mention suggestion family
  (`mentionFiles`/`mentionFolders`/`mentionWorktrees`/`mentionGitRoot`/
  `mentionGitBranches`/`mentionGitCommits`), and
  `workspace.resolvePathsByRepoIdentifiers` resolved from the task index's
  epic associations. `epic.removeRepo` drops an association from the index.

- **Git surface** (`src/git/`): `git.getCapabilities` (git version + work-tree
  detection), `git.listChangedFiles@1.1` (porcelain-v2 parsing into the
  two-axis staged/unstaged/untracked/conflicted row model with per-stage
  numstat counts, index-side OIDs, repo-state detection for
  merge/rebase/am/cherry-pick/revert/bisect; parent-only view —
  `submodules: []`), `git.getFileDiff` / `git.getFileDiffs` (stage-scoped
  patches, `--no-index` for untracked, whitespace toggle, byte budgets with
  truncation flags), and the `git.subscribeStatus@1.0` stream: ref-counted
  5s polling per running directory, snapshot on subscribe, `updated` events
  only when the fingerprint moves (with `changedPaths`).

- **Boot-path streams**: `notifications.subscribe@1.0` (a per-user
  notifications Y.Doc relayed like the epic docs, persisted to
  `open-host-notifications/<user>.yupdate` — the host mints no rows of its
  own yet) and `resources.subscribe` (the contract's documented quiet state:
  one empty projection — no app sample, no owners, `null` epic aggregate —
  then heartbeats only, since the open host tracks no process trees).

- **Small single-shape methods**: `agent.list` (single-agent roster —
  `agents: []`, caller can't message peers), `host.getRateLimitUsage`
  (zeros + `providerRateLimits: null`; no Traycer-cloud aperture behind
  this host), `epic.mentionEpics` (live suggestions from the task index,
  `epic:<id>` ids matching the GUI's local builder for de-dupe),
  `epic.mentionSpecs/Tickets/Stories/Reviews` + `comments.listThreads`
  (empty, not failed — no artifact/comment store yet), and
  `editor.openPaths` (best-effort `xdg-open` of the editor's URL scheme).

## Roadmap (in dependency order)

1. Approvals surface (permission-mode prompts over `chat.subscribe`).
2. Worktree surfaces (`worktree.*`), then terminals.

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
