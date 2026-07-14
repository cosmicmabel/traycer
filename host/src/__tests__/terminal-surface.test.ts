// Runs under `bun test` — the server under test is built on Bun.serve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@cic/protocol/host/registry";
import { buildStreamManifest } from "@cic/protocol/framework/stream-compat";
import { hostFrameSchema } from "@cic/protocol/framework/ws-protocol";
import { terminalSubscribeServerFrameSchema } from "@cic/protocol/host/terminal/subscribe";
import { startOpenHostServer, type RunningOpenHost } from "../server";
import { RegistryRuntime } from "../registry-runtime";

/**
 * End-to-end terminal surface test: `terminal.create`/`list`/`rename`/`kill`
 * over `/rpc` and a live `terminal.subscribe` session against the spawned
 * PTY — snapshot, write echo, resize, rename push, and the exit frame.
 */
let server: RunningOpenHost;

beforeAll(() => {
  server = startOpenHostServer({
    port: 0,
    environment: `test-terminal-${process.pid}-${Date.now()}`,
    openclawGatewayUrl: "ws://127.0.0.1:9",
    openclawGatewayToken: null,
  });
});

afterAll(() => {
  server.stop();
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

interface StreamHarness {
  send(frame: unknown): void;
  next(timeoutMs: number): Promise<unknown>;
  close(): void;
}

async function dialStream(): Promise<StreamHarness> {
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
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("stream dial failed"));
  });
  return {
    send: (frame) => socket.send(JSON.stringify(frame)),
    next: (timeoutMs) =>
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
      }),
    close: () => socket.close(1000, "closed-by-caller"),
  };
}

function frameKind(frame: unknown): string {
  if (frame !== null && typeof frame === "object") {
    const kind = Reflect.get(frame, "kind");
    if (typeof kind === "string") {
      return kind;
    }
  }
  return "";
}

describe("terminal surface", () => {
  it("creates, attaches, echoes, resizes, renames, and kills a PTY session", async () => {
    const created = await callRpc("terminal.create", {
      epicId: "epic-t",
      sessionKind: "terminal",
      tuiHarnessId: null,
      cwd: tmpdir(),
      shellCommand: "/bin/bash",
      shellArgs: ["--noprofile", "--norc", "-i"],
      cols: 100,
      rows: 30,
      desiredSessionId: "term-1",
      worktreeBusyPaths: [],
    });
    expect(created.error).toBeNull();
    expect(created.result).toMatchObject({
      session: { sessionId: "term-1", status: "running", cols: 100 },
    });

    const listed = await callRpc("terminal.list", { epicId: "epic-t" });
    expect(
      (listed.result as { sessions: Array<{ sessionId: string }> }).sessions,
    ).toContainEqual(expect.objectContaining({ sessionId: "term-1" }));

    const session = await dialStream();
    session.send({
      kind: "open",
      token: "test-bearer",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
    });
    expect(frameKind(await session.next(5_000))).toBe("openAck");
    session.send({
      kind: "subscribe",
      method: "terminal.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { sessionId: "term-1", cols: 80, rows: 24 },
    });
    const snapshot = terminalSubscribeServerFrameSchema.parse(
      await session.next(5_000),
    );
    if (snapshot.kind !== "snapshot") {
      throw new Error("expected a snapshot frame");
    }
    // The attach recompute ran before the snapshot: min(100x30, 80x24).
    expect(snapshot.session.cols).toBe(80);
    expect(snapshot.session.rows).toBe(24);
    expect(snapshot.ackCreditSupported).toBe(false);

    // Write; the PTY echoes back through data frames.
    session.send({
      kind: "write",
      hasBinaryPayload: false,
      sessionId: "term-1",
      clientActionId: "w-1",
      data: "echo pty-roundtrip-$((20+3))\r",
    });
    let sawAck = false;
    let output = "";
    let guard = 0;
    while (!output.includes("pty-roundtrip-23") && guard < 60) {
      guard += 1;
      const frame = terminalSubscribeServerFrameSchema.parse(
        await session.next(8_000),
      );
      if (frame.kind === "actionAck" && frame.clientActionId === "w-1") {
        expect(frame.status).toBe("accepted");
        sawAck = true;
      }
      if (frame.kind === "data") {
        output += frame.chunk;
      }
    }
    expect(sawAck).toBe(true);
    expect(output).toContain("pty-roundtrip-23");

    // Resize: ack + resized broadcast (this viewer sees both).
    session.send({
      kind: "resize",
      hasBinaryPayload: false,
      sessionId: "term-1",
      clientActionId: "r-1",
      cols: 90,
      rows: 28,
    });
    let sawResized = false;
    let sawResizeAck = false;
    guard = 0;
    while ((!sawResized || !sawResizeAck) && guard < 30) {
      guard += 1;
      const frame = terminalSubscribeServerFrameSchema.parse(
        await session.next(5_000),
      );
      if (frame.kind === "resized") {
        expect(frame.cols).toBe(90);
        expect(frame.rows).toBe(28);
        sawResized = true;
      }
      if (frame.kind === "actionAck" && frame.clientActionId === "r-1") {
        sawResizeAck = true;
      }
    }
    expect(sawResized).toBe(true);

    // Rename over /rpc pushes sessionUpdated onto the stream.
    const renamed = await callRpc("terminal.rename", {
      sessionId: "term-1",
      title: "build shell",
    });
    expect(renamed.result).toMatchObject({ updated: true });
    let sawSessionUpdated = false;
    guard = 0;
    while (!sawSessionUpdated && guard < 30) {
      guard += 1;
      const frame = terminalSubscribeServerFrameSchema.parse(
        await session.next(5_000),
      );
      if (frame.kind === "sessionUpdated") {
        expect(frame.session.title).toBe("build shell");
        sawSessionUpdated = true;
      }
    }
    expect(sawSessionUpdated).toBe(true);

    // Ping heartbeat inside the terminal session.
    session.send({ kind: "ping", hasBinaryPayload: false });
    let sawPong = false;
    guard = 0;
    while (!sawPong && guard < 30) {
      guard += 1;
      if (frameKind(await session.next(5_000)) === "pong") {
        sawPong = true;
      }
    }
    expect(sawPong).toBe(true);

    // Kill: unary success + a live exit frame on the stream.
    const killed = await callRpc("terminal.kill", { sessionId: "term-1" });
    expect(killed.result).toMatchObject({ killed: true });
    let sawExit = false;
    guard = 0;
    while (!sawExit && guard < 30) {
      guard += 1;
      const frame = terminalSubscribeServerFrameSchema.parse(
        await session.next(8_000),
      );
      if (frame.kind === "exit") {
        sawExit = true;
      }
    }
    expect(sawExit).toBe(true);

    const after = await callRpc("terminal.list", { epicId: "epic-t" });
    expect(
      (after.result as { sessions: Array<{ sessionId: string }> }).sessions,
    ).toHaveLength(0);
    session.close();
  }, 40_000);

  it("fatals a subscribe to a missing session", async () => {
    const session = await dialStream();
    session.send({
      kind: "open",
      token: "test-bearer",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
    });
    await session.next(5_000);
    session.send({
      kind: "subscribe",
      method: "terminal.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { sessionId: "never-created", cols: 80, rows: 24 },
    });
    const frame = await session.next(5_000);
    expect(frameKind(frame)).toBe("fatalError");
    session.close();
  }, 20_000);
});
