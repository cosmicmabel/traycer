// Runs under `bun test` — the server under test is built on Bun.serve.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { hostStreamRpcRegistry } from "@cic/protocol/host/registry";
import { buildStreamManifest } from "@cic/protocol/framework/stream-compat";
import { epicSubscribeServerFrameSchema } from "@cic/protocol/host/epic/subscribe";
import { startOpenHostServer, type RunningOpenHost } from "../server";

/**
 * End-to-end epic.subscribe test: two real WebSocket subscribers on the same
 * epic exchange Y.Doc updates through the host's CRDT relay, with the
 * envelope+binary pairing the protocol specifies (a binary frame is the
 * payload of the immediately-preceding text envelope with
 * `hasBinaryPayload: true`).
 */
let server: RunningOpenHost;

beforeAll(() => {
  server = startOpenHostServer({
    port: 0,
    // Unique per run: epic persistence would otherwise replay prior test
    // docs, turning relayed updates into deltas a fresh doc can't resolve.
    environment: `test-epic-${process.pid}-${Date.now()}`,
    openclawGatewayUrl: "ws://127.0.0.1:9",
    openclawGatewayToken: null,
  });
});

afterAll(() => {
  server.stop();
});

type Paired = { readonly frame: unknown; readonly binary: Uint8Array | null };

interface EpicHarness {
  send(frame: unknown, binary: Uint8Array | null): void;
  next(): Promise<Paired>;
  close(): void;
}

async function dialEpic(epicId: string): Promise<EpicHarness> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/stream`);
  socket.binaryType = "arraybuffer";
  const queue: Paired[] = [];
  const waiters: Array<(pair: Paired) => void> = [];
  let pendingEnvelope: unknown | null = null;
  const deliver = (pair: Paired): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(pair);
      return;
    }
    queue.push(pair);
  };
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data === "string") {
      const frame: unknown = JSON.parse(event.data);
      const hasBinary =
        frame !== null &&
        typeof frame === "object" &&
        Reflect.get(frame, "hasBinaryPayload") === true;
      if (hasBinary) {
        pendingEnvelope = frame;
        return;
      }
      deliver({ frame, binary: null });
      return;
    }
    const envelope = pendingEnvelope;
    pendingEnvelope = null;
    deliver({
      frame: envelope,
      binary: new Uint8Array(event.data as ArrayBuffer),
    });
  };
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
  const harness: EpicHarness = {
    send: (frame, binary) => {
      socket.send(JSON.stringify(frame));
      if (binary !== null) {
        socket.send(binary);
      }
    },
    next: () =>
      new Promise<Paired>((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for an epic frame")),
          8_000,
        );
        waiters.push((pair) => {
          clearTimeout(timer);
          resolve(pair);
        });
      }),
    close: () => socket.close(1000, "closed-by-caller"),
  };
  const ack = await harness.next();
  expect(Reflect.get(ack.frame ?? {}, "kind")).toBe("openAck");
  harness.send(
    {
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 0 },
      params: { epicId },
    },
    null,
  );
  return harness;
}

async function readSnapshot(harness: EpicHarness): Promise<Y.Doc> {
  // snapshot (binary) then cloudSyncStatus, in order; room snapshots may
  // follow but are not consumed here.
  const snapshot = await harness.next();
  const parsed = epicSubscribeServerFrameSchema.parse(snapshot.frame);
  expect(parsed.kind).toBe("snapshot");
  if (snapshot.binary === null) {
    throw new Error("snapshot frame carried no binary payload");
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot.binary);
  const sync = await harness.next();
  expect(epicSubscribeServerFrameSchema.parse(sync.frame).kind).toBe(
    "cloudSyncStatus",
  );
  return doc;
}

describe("epic.subscribe Y.Doc relay", () => {
  it("relays applyUpdate to other subscribers and replays it in snapshots", async () => {
    const alice = await dialEpic("epic-sync");
    await readSnapshot(alice);
    const bob = await dialEpic("epic-sync");
    await readSnapshot(bob);

    // Alice writes a chat title into the root doc and pushes the update.
    const aliceDoc = new Y.Doc();
    aliceDoc.getMap("chats").set("chat-1", "OpenClaw chat");
    alice.send(
      { kind: "applyUpdate", epicId: "epic-sync", hasBinaryPayload: true },
      Y.encodeStateAsUpdate(aliceDoc),
    );

    // Bob receives the relayed update and converges.
    const relayed = await bob.next();
    const frame = epicSubscribeServerFrameSchema.parse(relayed.frame);
    expect(frame.kind).toBe("update");
    if (relayed.binary === null) {
      throw new Error("update frame carried no binary payload");
    }
    const bobDoc = new Y.Doc();
    Y.applyUpdate(bobDoc, relayed.binary);
    expect(bobDoc.getMap("chats").get("chat-1")).toBe("OpenClaw chat");

    // A brand-new subscriber sees the write in its snapshot.
    const carol = await dialEpic("epic-sync");
    const carolDoc = await readSnapshot(carol);
    expect(carolDoc.getMap("chats").get("chat-1")).toBe("OpenClaw chat");

    alice.close();
    bob.close();
    carol.close();
  }, 20_000);

  it("relays awareness bytes opaquely to the other subscriber", async () => {
    const alice = await dialEpic("epic-aware");
    await readSnapshot(alice);
    const bob = await dialEpic("epic-aware");
    await readSnapshot(bob);

    const awarenessBytes = new Uint8Array([1, 2, 3, 4]);
    alice.send(
      { kind: "awareness", epicId: "epic-aware", hasBinaryPayload: true },
      awarenessBytes,
    );
    const relayed = await bob.next();
    expect(epicSubscribeServerFrameSchema.parse(relayed.frame).kind).toBe(
      "awareness",
    );
    expect(relayed.binary).toEqual(awarenessBytes);

    alice.close();
    bob.close();
  });

  it("answers ping with pong inside an epic subscription", async () => {
    const session = await dialEpic("epic-ping");
    await readSnapshot(session);
    session.send({ kind: "ping", hasBinaryPayload: false }, null);
    const pong = await session.next();
    expect(epicSubscribeServerFrameSchema.parse(pong.frame).kind).toBe("pong");
    session.close();
  });
});
