// Runs under `bun test` — the server under test is built on Bun.serve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@cic/protocol/host/registry";
import { buildStreamManifest } from "@cic/protocol/framework/stream-compat";
import { hostFrameSchema } from "@cic/protocol/framework/ws-protocol";
import { worktreeDeleteByPathServerFrameSchema } from "@cic/protocol/host/worktree-delete-stream";
import { startOpenHostServer, type RunningOpenHost } from "../server";
import { RegistryRuntime } from "../registry-runtime";

/**
 * Worktree mutation pipeline over the wire: create (new branch + carried
 * tracked changes + setup script in a real terminal session), binding
 * reads/mutations, the host-wide listing, createPaths, unary delete, and
 * the `worktree.deleteByPath` stream with a teardown phase.
 */
let server: RunningOpenHost;
let workspacePath: string;

const OWNER = { epicId: "epic-wm", ownerKind: "chat", ownerId: "chat-wm" };

async function git(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: workspacePath,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with ${exitCode}`);
  }
}

beforeAll(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), "open-host-wt-mut-"));
  await writeFile(join(workspacePath, "README.md"), "base\n");
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["branch", "feat-existing"]);
  // A tracked modification for the carry-uncommitted path.
  await writeFile(join(workspacePath, "README.md"), "base\ncarried\n");

  server = startOpenHostServer({
    port: 0,
    environment: `test-wt-mut-${process.pid}-${Date.now()}`,
    openclawGatewayUrl: "ws://127.0.0.1:9",
    openclawGatewayToken: null,
  });
});

afterAll(async () => {
  server.stop();
  await rm(workspacePath, { recursive: true, force: true });
});

async function callRpc(
  method: string,
  params: unknown,
): Promise<{ result: unknown; error: unknown }> {
  const manifest = new RegistryRuntime(hostRpcRegistry).buildManifest();
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
  const frames: unknown[] = [];
  const waiters: Array<(frame: unknown) => void> = [];
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") {
      return;
    }
    const frame: unknown = JSON.parse(event.data);
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(frame);
      return;
    }
    frames.push(frame);
  };
  const next = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const queued = frames.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for an rpc frame")),
        8_000,
      );
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("rpc dial failed"));
  });
  socket.send(JSON.stringify({ kind: "open", token: "test-bearer", manifest }));
  const ack = hostFrameSchema.parse(await next());
  expect(ack.kind).toBe("openAck");
  socket.send(
    JSON.stringify({
      kind: "request",
      requestId: "req-1",
      method,
      schemaVersion: manifest[method],
      params,
    }),
  );
  const response = hostFrameSchema.parse(await next());
  socket.close(1000, "ok");
  if (response.kind !== "response") {
    throw new Error(`expected a response frame, got ${response.kind}`);
  }
  return { result: response.result, error: response.error };
}

interface BindingView {
  entries: Array<{
    workspacePath: string;
    mode: string;
    worktreePath: string | null;
    branch: string | null;
    setupState: string;
    setupTerminalSessionId: string | null;
    setupExitCode: number | null;
  }>;
}

async function getBinding(): Promise<BindingView | null> {
  const read = await callRpc("worktree.getBinding", OWNER);
  return (read.result as { binding: BindingView | null }).binding;
}

let createdWorktreePath = "";

describe("worktree mutations", () => {
  it("creates a worktree with carried changes and a setup terminal", async () => {
    const created = await callRpc("worktree.create", {
      ...OWNER,
      entries: [
        {
          kind: "worktree",
          workspacePath,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat-created",
            source: "main",
            carryUncommittedChanges: true,
          },
          scripts: {
            setup: {
              default: "echo ok > setup-marker.txt",
              macos: null,
              windows: null,
              linux: null,
            },
            teardown: { default: "", macos: null, windows: null, linux: null },
          },
        },
      ],
    });
    expect(created.error).toBeNull();
    const result = created.result as {
      binding: BindingView;
      perEntry: Array<{ ok: boolean; worktreePath: string | null }>;
    };
    expect(result.perEntry[0].ok).toBe(true);
    const entry = result.binding.entries[0];
    expect(entry.mode).toBe("worktree");
    expect(entry.branch).toBe("feat-created");
    expect(entry.setupState).toBe("running");
    expect(entry.setupTerminalSessionId).not.toBeNull();
    if (entry.worktreePath === null) {
      throw new Error("expected a worktree path");
    }
    createdWorktreePath = entry.worktreePath;

    // The tracked modification was carried into the new worktree.
    const carried = await readFile(
      join(createdWorktreePath, "README.md"),
      "utf8",
    );
    expect(carried).toContain("carried");

    // The setup script ran in a real terminal session and flipped the
    // binding to succeeded.
    let setupState = "running";
    for (let attempt = 0; attempt < 50 && setupState === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const binding = await getBinding();
      setupState = binding?.entries[0]?.setupState ?? "running";
    }
    expect(setupState).toBe("succeeded");
    const marker = await readFile(
      join(createdWorktreePath, "setup-marker.txt"),
      "utf8",
    );
    expect(marker).toContain("ok");
  }, 30_000);

  it("projects the binding into selector rows and the host listing", async () => {
    const rows = await callRpc("worktree.listBindingsForEpic", {
      epicId: OWNER.epicId,
    });
    expect(rows.error).toBeNull();
    const rowsResult = rows.result as {
      rows: Array<Record<string, unknown>>;
    };
    expect(rowsResult.rows).toHaveLength(1);
    expect(rowsResult.rows[0]).toMatchObject({
      runningDir: createdWorktreePath,
      mode: "worktree",
      isGitRepo: true,
      branch: "feat-created",
      setupState: "succeeded",
      disabledReason: null,
      sources: [{ ownerId: OWNER.ownerId, ownerKind: "chat" }],
    });

    const all = await callRpc("worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
    });
    expect(all.error).toBeNull();
    const allResult = all.result as {
      worktrees: Array<Record<string, unknown>>;
    };
    expect(allResult.worktrees).toHaveLength(1);
    expect(allResult.worktrees[0]).toMatchObject({
      worktreePath: createdWorktreePath,
      branch: "feat-created",
      inUse: true,
      gitRemovable: true,
      owners: [{ epicId: OWNER.epicId, ownerId: OWNER.ownerId }],
    });
  }, 20_000);

  it("flips entry mode, removes entries, and writes repo scripts", async () => {
    const flipped = await callRpc("worktree.setEntryMode", {
      ...OWNER,
      workspacePath,
    });
    expect(
      (flipped.result as { binding: BindingView }).binding.entries[0].mode,
    ).toBe("local");

    const scripts = await callRpc("worktree.setRepoScripts", {
      epicId: OWNER.epicId,
      workspacePath,
      setup: { default: "make dev", macos: null, windows: null, linux: null },
      teardown: { default: "", macos: null, windows: null, linux: null },
    });
    expect(scripts.result).toEqual({ updated: true });
    const written = await readFile(
      join(workspacePath, ".cic", "environment.json"),
      "utf8",
    );
    expect(written).toContain("make dev");

    const removed = await callRpc("workspaceBinding.removeEntry", {
      ...OWNER,
      workspacePath,
    });
    expect(
      (removed.result as { binding: BindingView }).binding.entries,
    ).toHaveLength(0);
  }, 20_000);

  it("creates ownerless paths and deletes them", async () => {
    const created = await callRpc("worktree.createPaths", {
      entries: [
        {
          workspacePath,
          branch: { type: "existing", name: "feat-existing" },
        },
      ],
    });
    expect(created.error).toBeNull();
    const result = created.result as {
      entries: Array<{ path: string; branch: string | null }>;
      perEntry: Array<{ ok: boolean }>;
    };
    expect(result.perEntry[0].ok).toBe(true);
    expect(result.entries[0].branch).toBe("feat-existing");
    const path = result.entries[0].path;
    expect((await stat(path)).isDirectory()).toBe(true);

    const deleted = await callRpc("worktree.delete", {
      epicId: OWNER.epicId,
      workspacePath,
      worktreePath: path,
    });
    expect(deleted.result).toEqual({ deleted: true });
    expect(await stat(path).catch(() => null)).toBeNull();
  }, 20_000);

  it("streams the deleteByPath pipeline with a teardown phase", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/stream`);
    const queue: unknown[] = [];
    const waiters: Array<(frame: unknown) => void> = [];
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      const frame: unknown = JSON.parse(event.data);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(frame);
        return;
      }
      queue.push(frame);
    };
    const next = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a stream frame")),
          10_000,
        );
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("stream dial failed"));
    });
    socket.send(
      JSON.stringify({
        kind: "open",
        token: "test-bearer",
        manifest: buildStreamManifest(hostStreamRpcRegistry),
      }),
    );
    await next(); // openAck
    socket.send(
      JSON.stringify({
        kind: "subscribe",
        method: "worktree.deleteByPath",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          worktreePath: createdWorktreePath,
          scripts: {
            setup: { default: "", macos: null, windows: null, linux: null },
            teardown: {
              default: "echo teardown-ran",
              macos: null,
              windows: null,
              linux: null,
            },
          },
        },
      }),
    );

    const kinds: string[] = [];
    const phases: string[] = [];
    let output = "";
    let done = false;
    let guard = 0;
    while (!done && guard < 40) {
      guard += 1;
      const frame = worktreeDeleteByPathServerFrameSchema.parse(await next());
      kinds.push(frame.kind);
      if (frame.kind === "started") {
        expect(frame.hasTeardown).toBe(true);
      }
      if (frame.kind === "phase") {
        phases.push(frame.phase);
      }
      if (frame.kind === "output") {
        output += frame.chunk;
      }
      if (frame.kind === "complete") {
        expect(frame.deleted).toBe(true);
        done = true;
      }
      if (frame.kind === "failed") {
        throw new Error(`delete failed: ${frame.reason}`);
      }
    }
    expect(kinds[0]).toBe("started");
    expect(phases).toEqual(["teardown", "remove"]);
    expect(output).toContain("teardown-ran");
    expect(await stat(createdWorktreePath).catch(() => null)).toBeNull();
    socket.close(1000, "closed-by-caller");
  }, 30_000);
});
