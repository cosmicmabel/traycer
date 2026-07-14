// Runs under `bun test` — the server under test is built on Bun.serve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRpcRegistry } from "@cic/protocol/host/registry";
import { hostFrameSchema } from "@cic/protocol/framework/ws-protocol";
import { startOpenHostServer, type RunningOpenHost } from "../server";
import { RegistryRuntime } from "../registry-runtime";
import { parseRepoIdentifierFromRemoteUrl } from "../workspace/workspace-service";

/**
 * End-to-end `workspace.*` surface test against a real on-disk git repo:
 * folder preparation (remote-URL → repo identifier), file tree + git status,
 * directory listing, bounded file reads, and the mention suggestion family.
 */
let server: RunningOpenHost;
let workspacePath: string;

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
  workspacePath = await mkdtemp(join(tmpdir(), "open-host-workspace-"));
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(
    join(workspacePath, "src", "alpha.ts"),
    "export const a = 1;\n",
  );
  await writeFile(join(workspacePath, "README.md"), "# fixture\n");
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["add", "."]);
  await git(["commit", "-m", "fixture: initial layout"]);
  await git(["branch", "feature/mentions"]);
  await git(["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
  // One untracked file so gitStatus has a row.
  await writeFile(join(workspacePath, "notes.txt"), "untracked\n");

  server = startOpenHostServer({
    port: 0,
    environment: `test-workspace-${process.pid}-${Date.now()}`,
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

describe("workspace unary surface", () => {
  it("prepares folders and parses the origin remote into a repo identifier", async () => {
    const prepared = await callRpc("workspace.prepareFolders", {
      folderPaths: [workspacePath, "/definitely/not/a/real/folder"],
    });
    expect(prepared.error).toBeNull();
    // `repoUrl` is asserted loosely: a machine-level `url.insteadOf` rewrite
    // may change the transport, but owner/repo parsing must survive it.
    expect(prepared.result).toMatchObject({
      folders: [
        {
          workspacePath,
          repoIdentifier: { owner: "acme", repo: "widgets" },
        },
      ],
      repoIdentifiers: [{ owner: "acme", repo: "widgets" }],
    });
    const folder = (
      prepared.result as { folders: Array<{ repoUrl: string | null }> }
    ).folders[0];
    expect(folder.repoUrl).toContain("acme/widgets");
  }, 20_000);

  it("lists the file tree with git status and reads files with a byte cap", async () => {
    const tree = await callRpc("workspace.listFileTree", {
      workspacePath,
      maxFiles: 1000,
      includeIgnored: false,
    });
    expect(tree.error).toBeNull();
    const treeResult = tree.result as {
      files: Array<{ path: string; name: string }>;
      gitStatus: Array<{ path: string; status: string }>;
      truncated: boolean;
    };
    expect(treeResult.truncated).toBe(false);
    expect(treeResult.files).toContainEqual({
      path: "src/alpha.ts",
      name: "alpha.ts",
    });
    expect(treeResult.gitStatus).toContainEqual({
      path: "notes.txt",
      status: "untracked",
    });

    const listed = await callRpc("workspace.listDirectory", {
      workspacePath,
      directoryPath: "src",
    });
    expect(listed.error).toBeNull();
    expect(
      (listed.result as { entries: Array<Record<string, unknown>> }).entries,
    ).toContainEqual({ path: "src/alpha.ts", name: "alpha.ts", kind: "file" });

    const read = await callRpc("workspace.readFile", {
      workspacePath,
      filePath: "src/alpha.ts",
      maxBytes: 6,
    });
    expect(read.error).toBeNull();
    expect(read.result).toMatchObject({
      content: "export",
      truncated: true,
      error: null,
    });

    const escaped = await callRpc("workspace.readFile", {
      workspacePath,
      filePath: "../outside.txt",
      maxBytes: 100,
    });
    expect(escaped.error).toBeNull();
    expect(escaped.result).toMatchObject({
      content: null,
      error: "path escapes the workspace root",
    });
  }, 20_000);

  it("serves file/folder/git mention suggestions from the repo", async () => {
    const files = await callRpc("workspace.mentionFiles", {
      roots: [workspacePath],
      query: "alpha",
      limit: 10,
    });
    expect(files.error).toBeNull();
    expect(files.result).toMatchObject({
      entries: [
        {
          kind: "file",
          label: "alpha.ts",
          relPath: "src/alpha.ts",
          workspacePath,
        },
      ],
    });

    const folders = await callRpc("workspace.mentionFolders", {
      roots: [workspacePath],
      query: "sr",
      limit: 10,
    });
    expect(folders.error).toBeNull();
    expect(folders.result).toMatchObject({
      entries: [{ kind: "folder", label: "src", relPath: "src" }],
    });

    const branches = await callRpc("workspace.mentionGitBranches", {
      workspacePath,
      query: "feature",
      limit: 10,
    });
    expect(branches.error).toBeNull();
    expect(branches.result).toMatchObject({
      entries: [
        {
          kind: "git",
          gitType: "against_branch",
          branchName: "feature/mentions",
        },
      ],
    });

    const commits = await callRpc("workspace.mentionGitCommits", {
      workspacePath,
      query: "fixture",
      limit: 10,
    });
    expect(commits.error).toBeNull();
    const commitEntries = (
      commits.result as {
        entries: Array<{ gitType: string; commitHash: string; label: string }>;
      }
    ).entries;
    expect(commitEntries).toHaveLength(1);
    expect(commitEntries[0].label).toBe("fixture: initial layout");
    expect(commitEntries[0].commitHash).toMatch(/^[0-9a-f]{40}$/);

    const root = await callRpc("workspace.mentionGitRoot", {
      workspacePath,
      query: "",
      limit: 10,
    });
    expect(root.error).toBeNull();
    expect(root.result).toMatchObject({
      entries: [
        { gitType: "against_uncommitted_changes" },
        { gitType: "against_branch", branchName: "main" },
      ],
    });

    const worktrees = await callRpc("workspace.mentionWorktrees", {
      roots: [workspacePath],
      query: "",
      limit: 10,
    });
    expect(worktrees.error).toBeNull();
    expect(worktrees.result).toMatchObject({
      entries: [{ kind: "worktree", branch: "main", isMain: true }],
    });
  }, 20_000);

  it("resolves repo identifiers to workspace paths via epic associations", async () => {
    await callRpc("epic.create", {
      epic: {
        id: "epic-ws1",
        title: "Workspace epic",
        initialUserPrompt: "prompt",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "local-user",
        version: "1",
      },
      repoIdentifiers: [{ owner: "acme", repo: "widgets" }],
      workspaces: [{ workspacePath }],
      chat: null,
    });

    const resolved = await callRpc("workspace.resolvePathsByRepoIdentifiers", {
      repoIdentifiers: [
        { owner: "acme", repo: "widgets" },
        { owner: "acme", repo: "unknown" },
      ],
    });
    expect(resolved.error).toBeNull();
    expect(resolved.result).toEqual({
      mappings: [
        {
          repoIdentifier: { owner: "acme", repo: "widgets" },
          workspacePath,
        },
      ],
    });

    const removed = await callRpc("epic.removeRepo", {
      epicId: "epic-ws1",
      repoIdentifier: { owner: "acme", repo: "widgets" },
    });
    expect(removed.error).toBeNull();
    expect(removed.result).toEqual({ success: true });
    const removedAgain = await callRpc("epic.removeRepo", {
      epicId: "epic-ws1",
      repoIdentifier: { owner: "acme", repo: "widgets" },
    });
    expect(removedAgain.result).toEqual({ success: false });
  }, 20_000);
});

describe("remote url parsing", () => {
  it("handles scp, ssh, and https remote forms", () => {
    expect(
      parseRepoIdentifierFromRemoteUrl("git@github.com:acme/widgets.git"),
    ).toEqual({ owner: "acme", repo: "widgets" });
    expect(
      parseRepoIdentifierFromRemoteUrl("https://github.com/acme/widgets"),
    ).toEqual({ owner: "acme", repo: "widgets" });
    expect(
      parseRepoIdentifierFromRemoteUrl(
        "ssh://git@gitlab.com/group/subgroup/widgets.git",
      ),
    ).toEqual({ owner: "subgroup", repo: "widgets" });
    expect(parseRepoIdentifierFromRemoteUrl("/local/bare/repo.git")).toBeNull();
  });
});
