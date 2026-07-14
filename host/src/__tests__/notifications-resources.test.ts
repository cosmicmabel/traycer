// Runs under `bun test` — the server under test is built on Bun.serve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { notificationsSubscribeServerFrameSchema } from "@traycer/protocol/host/notifications/subscribe";
import { resourcesSubscribeServerFrameSchema } from "@traycer/protocol/host/resources/subscribe";
import { startOpenHostServer, type RunningOpenHost } from "../server";

/**
 * Wire tests for the two boot-path streams: `notifications.subscribe`
 * (per-user Y.Doc relay with binary pairing) and `resources.subscribe`
 * (the contract's quiet empty projection).
 */
let server: RunningOpenHost;

beforeAll(() => {
  server = startOpenHostServer({
    port: 0,
    environment: `test-notif-${process.pid}-${Date.now()}`,
    openclawGatewayUrl: "ws://127.0.0.1:9",
    openclawGatewayToken: null,
  });
});

afterAll(() => {
  server.stop();
});

interface StreamHarness {
  sendText(frame: unknown): void;
  sendBinary(bytes: Uint8Array): void;
  next(): Promise<{ text: unknown | null; binary: Uint8Array | null }>;
  close(): void;
}

/** Queues text and binary frames separately, preserving arrival order. */
async function dialStream(): Promise<StreamHarness> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/stream`);
  socket.binaryType = "arraybuffer";
  type Item = { text: unknown | null; binary: Uint8Array | null };
  const queue: Item[] = [];
  const waiters: Array<(item: Item) => void> = [];
  const push = (item: Item): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return;
    }
    queue.push(item);
  };
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data === "string") {
      const parsed: unknown = JSON.parse(event.data);
      push({ text: parsed, binary: null });
      return;
    }
    push({
      text: null,
      binary: new Uint8Array(event.data as ArrayBuffer),
    });
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("stream dial failed"));
  });
  return {
    sendText: (frame) => socket.send(JSON.stringify(frame)),
    sendBinary: (bytes) => {
      socket.send(bytes);
    },
    next: () =>
      new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a stream frame")),
          8_000,
        );
        waiters.push((item) => {
          clearTimeout(timer);
          resolve(item);
        });
      }),
    close: () => socket.close(1000, "closed-by-caller"),
  };
}

async function openAndSubscribe(
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<StreamHarness> {
  const session = await dialStream();
  session.sendText({
    kind: "open",
    token: "test-bearer",
    manifest: buildStreamManifest(hostStreamRpcRegistry),
  });
  const ack = await session.next();
  expect(
    ack.text !== null && typeof ack.text === "object"
      ? Reflect.get(ack.text, "kind")
      : "",
  ).toBe("openAck");
  session.sendText({ kind: "subscribe", method, schemaVersion, params });
  return session;
}

describe("notifications.subscribe", () => {
  it("relays Y.Doc updates between subscribers of the same user", async () => {
    const first = await openAndSubscribe(
      "notifications.subscribe",
      { major: 1, minor: 0 },
      {},
    );
    const firstSnapshot = await first.next();
    const firstMeta = notificationsSubscribeServerFrameSchema.parse(
      firstSnapshot.text,
    );
    expect(firstMeta).toMatchObject({
      kind: "snapshot",
      meta: { schemaVersion: "1" },
    });
    const firstBinary = await first.next();
    expect(firstBinary.binary).not.toBeNull();

    const second = await openAndSubscribe(
      "notifications.subscribe",
      { major: 1, minor: 0 },
      {},
    );
    await second.next(); // snapshot envelope
    await second.next(); // snapshot binary

    // First pushes a doc update; second receives the relayed update.
    const doc = new Y.Doc();
    if (firstBinary.binary !== null) {
      Y.applyUpdate(doc, firstBinary.binary);
    }
    doc.getMap("notifications").set("n1", { read: false });
    first.sendText({ kind: "applyUpdate", hasBinaryPayload: true });
    first.sendBinary(Y.encodeStateAsUpdate(doc));

    const relayed = await second.next();
    expect(
      notificationsSubscribeServerFrameSchema.parse(relayed.text),
    ).toMatchObject({ kind: "update", hasBinaryPayload: true });
    const relayedBinary = await second.next();
    const secondDoc = new Y.Doc();
    if (relayedBinary.binary !== null) {
      Y.applyUpdate(secondDoc, relayedBinary.binary);
    }
    expect(secondDoc.getMap("notifications").get("n1")).toEqual({
      read: false,
    });

    // Heartbeat still answers inside the subscription.
    first.sendText({ kind: "ping", hasBinaryPayload: false });
    const pong = await first.next();
    expect(
      notificationsSubscribeServerFrameSchema.parse(pong.text),
    ).toMatchObject({ kind: "pong" });

    first.close();
    second.close();
  }, 20_000);
});

describe("agent.inbox.subscribe", () => {
  it("holds a quiet subscription that answers heartbeats", async () => {
    const session = await openAndSubscribe(
      "agent.inbox.subscribe",
      { major: 1, minor: 0 },
      { agentId: "agent-1", epicId: "epic-i" },
    );
    // No broker exists, so no snapshot/message frames arrive — the first
    // traffic is our own heartbeat's pong.
    session.sendText({ kind: "ping", hasBinaryPayload: false });
    const pong = await session.next();
    expect(
      pong.text !== null && typeof pong.text === "object"
        ? Reflect.get(pong.text, "kind")
        : "",
    ).toBe("pong");
    session.close();
  }, 20_000);
});

describe("resources.subscribe", () => {
  it("emits the quiet empty projection", async () => {
    const session = await openAndSubscribe(
      "resources.subscribe",
      { major: 1, minor: 1 },
      { epicId: "epic-r", scope: { kind: "epic", epicId: "epic-r" } },
    );
    const snapshot = await session.next();
    expect(
      resourcesSubscribeServerFrameSchema.parse(snapshot.text),
    ).toMatchObject({
      kind: "snapshot",
      epicId: "epic-r",
      app: null,
      owners: [],
      epic: null,
    });

    session.sendText({ kind: "ping", hasBinaryPayload: false });
    const pong = await session.next();
    expect(
      snapshot.text !== null &&
        pong.text !== null &&
        typeof pong.text === "object"
        ? Reflect.get(pong.text, "kind")
        : "",
    ).toBe("pong");
    session.close();
  }, 20_000);
});
