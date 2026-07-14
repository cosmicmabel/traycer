// Runs under `bun test` — the server under test is built on Bun.serve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@cic/protocol/host/registry";
import { buildStreamManifest } from "@cic/protocol/framework/stream-compat";
import { hostFrameSchema } from "@cic/protocol/framework/ws-protocol";
import { gitSubscribeStatusEventSchema } from "@cic/protocol/host/git-schemas";
import { startOpenHostServer, type RunningOpenHost } from "../server";
import { RegistryRuntime } from "../registry-runtime";

/**
 * End-to-end `git.*` surface test against a real on-disk repo: capabilities,
 * the two-axis changed-file list (staged/unstaged/untracked rows), stage-
 * scoped diffs with byte budgets, and the `git.subscribeStatus` stream
 * (snapshot event, ping→pong, and a poll-driven `updated` event).
 */
let server: RunningOpenHost;
let runningDir: string;
let plainDir: string;

async function git(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: runningDir,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with ${exitCode}`);
  }
}

beforeAll(async () => {
  runningDir = await mkdtemp(join(tmpdir(), "open-host-git-"));
  plainDir = await mkdtemp(join(tmpdir(), "open-host-plain-"));
  await writeFile(join(runningDir, "base.txt"), "one\ntwo\n");
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  // One row per stage axis: unstaged edit, staged add, untracked file.
  await writeFile(join(runningDir, "base.txt"), "one\ntwo\nthree\n");
  await writeFile(join(runningDir, "staged.txt"), "staged content\n");
  await git(["add", "staged.txt"]);
  await writeFile(join(runningDir, "notes.txt"), "untracked\n");

  server = startOpenHostServer({
    port: 0,
    environment: `test-git-${process.pid}-${Date.now()}`,
    openclawGatewayUrl: "ws://127.0.0.1:9",
    openclawGatewayToken: null,
  });
});

afterAll(async () => {
  server.stop();
  await rm(runningDir, { recursive: true, force: true });
  await rm(plainDir, { recursive: true, force: true });
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

describe("git unary surface", () => {
  it("reports capabilities for repos and non-repos", async () => {
    const capable = await callRpc("git.getCapabilities", {
      hostId: "open-host",
      runningDir,
      ignoreWhitespace: false,
    });
    expect(capable.error).toBeNull();
    expect(capable.result).toMatchObject({ available: true, reason: null });

    const incapable = await callRpc("git.getCapabilities", {
      hostId: "open-host",
      runningDir: plainDir,
      ignoreWhitespace: false,
    });
    expect(incapable.result).toMatchObject({
      available: false,
      reason: "running directory is not inside a git work tree",
    });
  }, 20_000);

  it("lists changed files across the stage axes", async () => {
    const listed = await callRpc("git.listChangedFiles", {
      hostId: "open-host",
      runningDir,
      ignoreWhitespace: false,
      includeSubmodules: false,
    });
    expect(listed.error).toBeNull();
    const result = listed.result as {
      headSha: string;
      branch: string | null;
      files: Array<Record<string, unknown>>;
      fingerprint: string;
      repoState: { kind: string };
      submodules: unknown[];
    };
    expect(result.branch).toBe("main");
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.repoState).toEqual({ kind: "clean" });
    expect(result.submodules).toEqual([]);
    expect(result.files).toContainEqual(
      expect.objectContaining({
        path: "base.txt",
        stage: "unstaged",
        status: "modified",
        insertions: 1,
        deletions: 0,
      }),
    );
    expect(result.files).toContainEqual(
      expect.objectContaining({
        path: "staged.txt",
        stage: "staged",
        status: "added",
        insertions: 1,
      }),
    );
    expect(result.files).toContainEqual(
      expect.objectContaining({
        path: "notes.txt",
        stage: "untracked",
        status: "untracked",
      }),
    );
  }, 20_000);

  it("serves stage-scoped diffs with byte budgets", async () => {
    const unstaged = await callRpc("git.getFileDiff", {
      hostId: "open-host",
      runningDir,
      filePath: "base.txt",
      previousPath: null,
      stage: "unstaged",
      ignoreWhitespace: false,
      byteBudget: null,
    });
    expect(unstaged.error).toBeNull();
    const unstagedResult = unstaged.result as {
      patch: string;
      isTruncated: boolean;
    };
    expect(unstagedResult.patch).toContain("+three");
    expect(unstagedResult.isTruncated).toBe(false);

    const staged = await callRpc("git.getFileDiff", {
      hostId: "open-host",
      runningDir,
      filePath: "staged.txt",
      previousPath: null,
      stage: "staged",
      ignoreWhitespace: false,
      byteBudget: null,
    });
    expect((staged.result as { patch: string }).patch).toContain(
      "+staged content",
    );

    const untracked = await callRpc("git.getFileDiff", {
      hostId: "open-host",
      runningDir,
      filePath: "notes.txt",
      previousPath: null,
      stage: "untracked",
      ignoreWhitespace: false,
      byteBudget: 10,
    });
    expect(untracked.result).toMatchObject({
      isTruncated: true,
      truncatedAfterBytes: 10,
    });

    const batch = await callRpc("git.getFileDiffs", {
      hostId: "open-host",
      runningDir,
      files: [
        { filePath: "base.txt", previousPath: null, stage: "unstaged" },
        { filePath: "staged.txt", previousPath: null, stage: "staged" },
      ],
      ignoreWhitespace: false,
      byteBudget: 1_000_000,
    });
    expect(batch.error).toBeNull();
    const diffs = (batch.result as { diffs: Array<{ patch: string }> }).diffs;
    expect(diffs).toHaveLength(2);
    expect(diffs[0].patch).toContain("+three");
    expect(diffs[1].patch).toContain("+staged content");
  }, 20_000);
});

describe("git.subscribeStatus stream", () => {
  it("emits a snapshot, answers pings, and pushes poll-driven updates", async () => {
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
    const next = (timeoutMs: number): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a stream frame")),
          timeoutMs,
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
    const ack = await next(5_000);
    expect(
      ack !== null && typeof ack === "object" ? Reflect.get(ack, "kind") : "",
    ).toBe("openAck");

    socket.send(
      JSON.stringify({
        kind: "subscribe",
        method: "git.subscribeStatus",
        schemaVersion: { major: 1, minor: 0 },
        params: { hostId: "open-host", runningDir, ignoreWhitespace: false },
      }),
    );
    const snapshot = gitSubscribeStatusEventSchema.parse(await next(5_000));
    if (snapshot.type !== "snapshot") {
      throw new Error("expected a snapshot event");
    }
    expect(snapshot.branch).toBe("main");
    expect(snapshot.files.map((file) => file.path)).toContain("notes.txt");

    // Transport-level heartbeat still answers on a git stream.
    socket.send(JSON.stringify({ kind: "ping", hasBinaryPayload: false }));
    const pong = await next(5_000);
    expect(
      pong !== null && typeof pong === "object"
        ? Reflect.get(pong, "kind")
        : "",
    ).toBe("pong");

    // Change the worktree; the fixed 5s poll must push an `updated` event.
    await writeFile(join(runningDir, "second-untracked.txt"), "new\n");
    const updated = gitSubscribeStatusEventSchema.parse(await next(12_000));
    if (updated.type !== "updated") {
      throw new Error("expected an updated event");
    }
    expect(updated.changedPaths).toContain("second-untracked.txt");
    expect(updated.files.map((file) => file.path)).toContain(
      "second-untracked.txt",
    );
    socket.close(1000, "closed-by-caller");
  }, 30_000);
});
