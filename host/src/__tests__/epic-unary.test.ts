// Runs under `bun test` — the server under test is built on Bun.serve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import { startOpenHostServer, type RunningOpenHost } from "../server";
import { RegistryRuntime } from "../registry-runtime";

/**
 * End-to-end epic unary surface test: `epic.create` (with a folded chat
 * seed) and `epic.listTasks` over `/rpc`, then an `epic.subscribe` stream
 * subscriber confirms the created chat record landed in the epic Y.Doc's
 * `chats` map via the host-side seeding write path.
 */
let server: RunningOpenHost;

beforeAll(() => {
  server = startOpenHostServer({
    port: 0,
    environment: `test-epic-unary-${process.pid}`,
    authnBaseUrl: "http://127.0.0.1:9",
    insecureNoAuth: true,
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

function epicLight(id: string, title: string): Record<string, unknown> {
  const now = Date.now();
  return {
    id,
    title,
    initialUserPrompt: "build me a thing",
    ticketCount: 0,
    specCount: 0,
    storyCount: 0,
    reviewCount: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
    createdBy: "insecure-local-user",
    version: "1",
  };
}

describe("epic unary surface", () => {
  it("creates an epic with a folded chat, lists it, and seeds the Y.Doc", async () => {
    const create = await callRpc("epic.create", {
      epic: epicLight("epic-u1", "My first epic"),
      repoIdentifiers: [],
      workspaces: [],
      chat: {
        chatId: "chat-u1",
        parentId: null,
        hostId: "open-host",
        title: "First chat",
        worktreeIntent: null,
        initialMessage: null,
      },
    });
    expect(create.error).toBeNull();
    expect(create.result).toMatchObject({
      roomInfo: null,
      initialTurnStarted: false,
      task: { epic: { light: { id: "epic-u1", title: "My first epic" } } },
    });

    const list = await callRpc("epic.listTasks", {
      limit: 10,
      filters: null,
      extensionPhaseVersion: "1",
      extensionEpicVersion: "1",
    });
    expect(list.error).toBeNull();
    const tasks = (
      list.result as {
        tasks: Array<{ epic?: { light: { id: string } } | null }>;
      }
    ).tasks;
    expect(tasks.map((task) => task.epic?.light.id)).toContain("epic-u1");

    // The folded chat seed is visible to an epic.subscribe snapshot.
    const doc = await snapshotEpicDoc("epic-u1");
    const chat = doc.getMap("chats").get("chat-u1");
    expect(chat).toMatchObject({ id: "chat-u1", title: "First chat" });
  }, 20_000);

  it("epic.createChat seeds a chat record into an existing epic", async () => {
    await callRpc("epic.create", {
      epic: epicLight("epic-u2", "Second epic"),
      repoIdentifiers: [],
      workspaces: [],
      chat: null,
    });
    const created = await callRpc("epic.createChat", {
      epicId: "epic-u2",
      parentId: null,
      hostId: "open-host",
      title: "Later chat",
      chatId: "chat-u2",
    });
    expect(created.error).toBeNull();
    expect(created.result).toMatchObject({ chatId: "chat-u2" });

    const doc = await snapshotEpicDoc("epic-u2");
    expect(doc.getMap("chats").get("chat-u2")).toMatchObject({
      id: "chat-u2",
      title: "Later chat",
    });
  }, 20_000);
});

async function snapshotEpicDoc(epicId: string): Promise<Y.Doc> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/stream`);
  socket.binaryType = "arraybuffer";
  const doc = new Y.Doc();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("epic snapshot timed out")),
      8_000,
    );
    let expectBinary = false;
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        const frame: unknown = JSON.parse(event.data);
        const kind =
          frame !== null && typeof frame === "object"
            ? Reflect.get(frame, "kind")
            : null;
        if (kind === "openAck") {
          socket.send(
            JSON.stringify({
              kind: "subscribe",
              method: "epic.subscribe",
              schemaVersion: { major: 1, minor: 0 },
              params: { epicId },
            }),
          );
          return;
        }
        if (kind === "snapshot") {
          expectBinary = true;
        }
        return;
      }
      if (expectBinary) {
        clearTimeout(timer);
        Y.applyUpdate(doc, new Uint8Array(event.data as ArrayBuffer));
        socket.close(1000, "closed-by-caller");
        resolve();
      }
    };
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          kind: "open",
          token: "test-bearer",
          manifest: buildStreamManifest(hostStreamRpcRegistry),
        }),
      );
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("stream dial failed"));
    };
  });
  return doc;
}
