// Runs under `bun test` — the server under test is built on Bun.serve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRpcRegistry } from "@cic/protocol/host/registry";
import { hostFrameSchema } from "@cic/protocol/framework/ws-protocol";
import { startOpenHostServer, type RunningOpenHost } from "../server";
import { RegistryRuntime } from "../registry-runtime";

/**
 * Read-only `worktree.*` slice over `/rpc`: branch listings with the
 * uncommitted-count pseudo-entry input, the pre-Epic disk-truth workspace
 * summary (including a committed-scripts-at-ref read), the null binding, the
 * folderless cwd, and the empty host-worktree listing.
 */
let server: RunningOpenHost;
let workspacePath: string;

const SCRIPTS_FIXTURE = {
  setup: { default: "bun install", macos: null, windows: null, linux: null },
  teardown: { default: "", macos: null, windows: null, linux: null },
  updatedAt: 1720000000000,
};

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
  workspacePath = await mkdtemp(join(tmpdir(), "open-host-worktree-"));
  await mkdir(join(workspacePath, ".cic"), { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# fixture\n");
  await writeFile(
    join(workspacePath, ".cic", "environment.json"),
    JSON.stringify(SCRIPTS_FIXTURE),
  );
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["branch", "feature/one"]);
  await git(["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
  await writeFile(join(workspacePath, "dirty.txt"), "uncommitted\n");

  server = startOpenHostServer({
    port: 0,
    environment: `test-worktree-${process.pid}-${Date.now()}`,
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
        5_000,
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

describe("worktree read slice", () => {
  it("lists branches with current/remote flags and the uncommitted count", async () => {
    const listed = await callRpc("worktree.listBranches", {
      workspacePath,
      includeRemote: true,
    });
    expect(listed.error).toBeNull();
    const result = listed.result as {
      branches: Array<{
        name: string;
        isCurrent: boolean;
        isRemoteOnly: boolean;
      }>;
      uncommittedFileCount: number;
    };
    expect(result.branches).toContainEqual({
      name: "main",
      isCurrent: true,
      isRemoteOnly: false,
    });
    expect(result.branches).toContainEqual({
      name: "feature/one",
      isCurrent: false,
      isRemoteOnly: false,
    });
    expect(result.uncommittedFileCount).toBe(1);
  }, 20_000);

  it("summarizes workspaces and reads committed scripts at a ref", async () => {
    const listed = await callRpc("worktree.listByWorkspacePaths", {
      workspacePaths: [workspacePath, "/definitely/not/a/repo"],
      scriptRefs: [
        { workspacePath, ref: "main" },
        { workspacePath, ref: "no-such-branch" },
      ],
    });
    expect(listed.error).toBeNull();
    const result = listed.result as {
      workspaces: Array<Record<string, unknown>>;
      scriptsAtRefs: Array<{ ref: string; scripts: unknown }>;
    };
    expect(result.workspaces[0]).toMatchObject({
      workspacePath,
      isGitRepo: true,
      repoIdentifier: { owner: "acme", repo: "widgets" },
      mainBranch: "main",
      scripts: SCRIPTS_FIXTURE,
    });
    const worktrees = result.workspaces[0].worktrees as Array<{
      isMain: boolean;
      branch: string | null;
    }>;
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({ isMain: true, branch: "main" });
    expect(result.workspaces[1]).toMatchObject({
      isGitRepo: false,
      repoIdentifier: null,
      worktrees: [],
    });
    expect(result.scriptsAtRefs[0]).toMatchObject({
      ref: "main",
      scripts: SCRIPTS_FIXTURE,
    });
    expect(result.scriptsAtRefs[1]).toMatchObject({
      ref: "no-such-branch",
      scripts: null,
    });
  }, 20_000);

  it("answers binding reads and mints a folderless cwd", async () => {
    const binding = await callRpc("worktree.getBinding", {
      epicId: "epic-w",
      ownerId: "chat-w",
      ownerKind: "chat",
    });
    expect(binding.error).toBeNull();
    expect(binding.result).toEqual({
      binding: null,
      missingWorktreePaths: [],
    });

    const bindings = await callRpc("worktree.listBindingsForEpic", {
      epicId: "epic-w",
    });
    expect(bindings.error).toBeNull();
    const bindingsResult = bindings.result as {
      rows: unknown[];
      folderlessCwd: string;
    };
    expect(bindingsResult.rows).toEqual([]);
    expect(bindingsResult.folderlessCwd).toContain("open-host-epic-cwd");

    const all = await callRpc("worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
    });
    expect(all.error).toBeNull();
    expect(all.result).toEqual({ worktrees: [] });
  }, 20_000);
});
