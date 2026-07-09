// Runs under `bun test` (not vitest): the server under test is built on
// `Bun.serve`, which only exists in the Bun runtime.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  hostFrameSchema,
  type ConnectionManifest,
} from "@traycer/protocol/framework/ws-protocol";
import { startOpenHostServer, type RunningOpenHost } from "../server";
import { RegistryRuntime } from "../registry-runtime";

/**
 * End-to-end wire tests: dial the running open host over a real WebSocket
 * and speak the exact frame sequences the shared client transports emit
 * (open → openAck → request → response), asserting byte-level contract
 * behavior including cross-major response downgrades.
 */
let server: RunningOpenHost;
let manifest: ConnectionManifest;

beforeAll(() => {
  manifest = new RegistryRuntime(hostRpcRegistry).buildManifest();
  server = startOpenHostServer({
    port: 0,
    environment: "test",
    authnBaseUrl: "http://127.0.0.1:9", // never reachable - tests use no-auth
    insecureNoAuth: true,
    // Discard port: the gateway probe must fail fast and report unreachable.
    openclawGatewayUrl: "ws://127.0.0.1:9",
    openclawGatewayToken: null,
  });
});

afterAll(() => {
  server.stop();
});

interface WireSession {
  send(frame: unknown): void;
  next(): Promise<unknown>;
  close(): void;
}

async function dial(path: "/rpc" | "/stream"): Promise<WireSession> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
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
    socket.onerror = () => reject(new Error("dial failed"));
  });
  return {
    send: (frame) => socket.send(JSON.stringify(frame)),
    next: () =>
      new Promise<unknown>((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a host frame")),
          5_000,
        );
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
    close: () => socket.close(1000, "ok"),
  };
}

async function openRpc(
  session: WireSession,
  clientManifest: ConnectionManifest,
): Promise<void> {
  session.send({
    kind: "open",
    token: "test-bearer",
    manifest: clientManifest,
  });
  const ack = hostFrameSchema.parse(await session.next());
  expect(ack.kind).toBe("openAck");
}

async function callRpc(
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
  clientManifest: ConnectionManifest,
): Promise<{
  result: unknown;
  error: { code: string; message: string } | null;
}> {
  const session = await dial("/rpc");
  await openRpc(session, clientManifest);
  session.send({
    kind: "request",
    requestId: "req-1",
    method,
    schemaVersion,
    params,
  });
  const frame = hostFrameSchema.parse(await session.next());
  session.close();
  if (frame.kind !== "response") {
    throw new Error(`expected a response frame, got ${frame.kind}`);
  }
  expect(frame.requestId).toBe("req-1");
  expect(frame.method).toBe(method);
  return { result: frame.result, error: frame.error };
}

describe("open host /rpc", () => {
  it("answers host.status after a manifest-identical handshake", async () => {
    const { result, error } = await callRpc(
      "host.status",
      manifest["host.status"],
      {},
      manifest,
    );
    expect(error).toBeNull();
    expect(result).toMatchObject({ ready: true, hostVersion: "0.0.0-open" });
  });

  it("advertises the openclaw harness in agent.gui.listHarnesses@4.0", async () => {
    const { result, error } = await callRpc(
      "agent.gui.listHarnesses",
      { major: 4, minor: 0 },
      {},
      manifest,
    );
    expect(error).toBeNull();
    const harnesses = (result as { harnesses: Array<{ id: string }> })
      .harnesses;
    expect(harnesses.map((harness) => harness.id)).toContain("openclaw");
  });

  it("downgrades providers.list for a v2.0 client (drops amp + openclaw)", async () => {
    const oldManifest: ConnectionManifest = {
      ...manifest,
      "providers.list": { major: 2, minor: 0 },
    };
    const { result, error } = await callRpc(
      "providers.list",
      { major: 2, minor: 0 },
      {},
      oldManifest,
    );
    expect(error).toBeNull();
    const providerIds = (
      result as { providers: Array<{ providerId: string }> }
    ).providers.map((provider) => provider.providerId);
    expect(providerIds).not.toContain("openclaw");
    expect(providerIds).not.toContain("amp");
    expect(providerIds).toContain("claude-code");
  });

  it("returns a structured RPC_ERROR for unimplemented methods", async () => {
    const { error } = await callRpc(
      "agent.list",
      manifest["agent.list"],
      {
        epicId: "epic-1",
        senderAgentId: "agent-1",
        scope: "all",
      },
      manifest,
    );
    expect(error).toMatchObject({ code: "RPC_ERROR" });
    expect(error?.message).toContain("not implemented");
  });

  it("rejects an incompatible manifest with a fatalError frame", async () => {
    // A client that does not know `host.status` at all: the oracle reports
    // client-missing-method, which is blocking for the whole connection.
    const incompleteManifest: Record<string, { major: number; minor: number }> =
      {};
    for (const [method, version] of Object.entries(manifest)) {
      if (method !== "host.status") {
        incompleteManifest[method] = version;
      }
    }
    const session = await dial("/rpc");
    session.send({
      kind: "open",
      token: "test-bearer",
      manifest: incompleteManifest,
    });
    const frame = hostFrameSchema.parse(await session.next());
    session.close();
    expect(frame.kind).toBe("fatalError");
    if (frame.kind === "fatalError") {
      expect(frame.details.code).toBe("INCOMPATIBLE");
      expect(
        frame.details.incompatibleMethods?.map((entry) => entry.method),
      ).toContain("host.status");
    }
  });
});

describe("open host /stream", () => {
  it("acks the stream handshake and rejects subscribes as unimplemented", async () => {
    const session = await dial("/stream");
    session.send({
      kind: "open",
      token: "test-bearer",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
    });
    const ack: unknown = await session.next();
    expect(ack).toMatchObject({ kind: "openAck", capabilities: [] });

    session.send({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-1", chatId: "chat-1" },
    });
    const fatal: unknown = await session.next();
    expect(fatal).toMatchObject({
      kind: "fatalError",
      details: { code: "RPC_ERROR" },
    });
    session.close();
  });
});

describe("open host /activity", () => {
  it("reports idle over plain HTTP with no bearer", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/activity`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ busy: false });
  });
});
