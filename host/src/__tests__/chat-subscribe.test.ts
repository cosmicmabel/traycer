// Runs under `bun test` — the host and the mock gateway are Bun.serve servers.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { chatSubscribeServerFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { startOpenHostServer, type RunningOpenHost } from "../server";
import { extractTextDelta, promptTextFromContent } from "../chat/chat-session";

/**
 * End-to-end chat.subscribe test: a mock OpenClaw Gateway (speaking the
 * req/res/event frame protocol) streams two cumulative `chat` deltas for
 * every `chat.send`; the test subscribes to the open host's chat stream over
 * a real WebSocket, sends a message, and asserts the full server frame
 * sequence — every frame is also parsed against the canonical
 * `chatSubscribeServerFrameSchema` so the wire shapes stay exact.
 */
interface MockGateway {
  readonly port: number | undefined;
  stop(closeActiveConnections: boolean): void;
}

let gateway: MockGateway;
let server: RunningOpenHost;
let lastGatewayPrompt: string | null = null;

beforeAll(() => {
  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, serverInstance) {
      return serverInstance.upgrade(request, { data: undefined })
        ? undefined
        : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, message) {
        if (typeof message !== "string") {
          return;
        }
        const frame: unknown = JSON.parse(message);
        if (frame === null || typeof frame !== "object") {
          return;
        }
        const id = Reflect.get(frame, "id");
        const method = Reflect.get(frame, "method");
        if (method === "connect") {
          ws.send(JSON.stringify({ type: "res", id, ok: true, payload: {} }));
          return;
        }
        if (method === "chat.send") {
          const params = Reflect.get(frame, "params");
          lastGatewayPrompt =
            params !== null && typeof params === "object"
              ? String(Reflect.get(params, "message"))
              : null;
          // A tool call bracketing the text: the `session.tool` event shape.
          ws.send(
            JSON.stringify({
              type: "event",
              event: "session.tool",
              payload: { name: "read_file", callId: "t1", phase: "start" },
            }),
          );
          ws.send(
            JSON.stringify({
              type: "event",
              event: "session.tool",
              payload: { name: "read_file", callId: "t1", phase: "end" },
            }),
          );
          // Cumulative assistant snapshots, the `chat.*` event shape.
          ws.send(
            JSON.stringify({
              type: "event",
              event: "chat.delta",
              payload: { deltaText: "Hello" },
            }),
          );
          ws.send(
            JSON.stringify({
              type: "event",
              event: "chat.delta",
              payload: { deltaText: "Hello from OpenClaw" },
            }),
          );
          ws.send(JSON.stringify({ type: "res", id, ok: true, payload: {} }));
        }
      },
    },
  });

  server = startOpenHostServer({
    port: 0,
    // Unique per run: chat persistence is real now, so a reused slot would
    // replay prior test transcripts into this suite's snapshots.
    environment: `test-chat-${process.pid}-${Date.now()}`,
    authnBaseUrl: "http://127.0.0.1:9",
    insecureNoAuth: true,
    openclawGatewayUrl: `ws://127.0.0.1:${gateway.port}`,
    openclawGatewayToken: null,
  });
});

afterAll(() => {
  server.stop();
  gateway.stop(true);
});

interface StreamHarness {
  send(frame: unknown): void;
  next(): Promise<unknown>;
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
    next: () =>
      new Promise<unknown>((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a stream frame")),
          8_000,
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

describe("chat.subscribe backed by the OpenClaw gateway", () => {
  it("streams a full send turn: snapshot → ack → message → deltas → completion", async () => {
    const session = await dialStream();
    session.send({
      kind: "open",
      token: "test-bearer",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
    });
    expect(frameKind(await session.next())).toBe("openAck");

    session.send({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-1", chatId: "chat-1" },
    });

    const snapshot = chatSubscribeServerFrameSchema.parse(await session.next());
    expect(snapshot.kind).toBe("snapshot");
    if (snapshot.kind === "snapshot") {
      expect(snapshot.snapshot.runStatus).toBe("idle");
      expect(snapshot.snapshot.access.canAct).toBe(true);
      expect(snapshot.snapshot.chat.id).toBe("chat-1");
    }

    session.send({
      kind: "send",
      epicId: "epic-1",
      chatId: "chat-1",
      hasBinaryPayload: false,
      clientActionId: "action-1",
      messageId: "msg-1",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Say hello" }],
          },
        ],
      },
      sender: { type: "user", userId: "insecure-local-user" },
      settings: {
        harnessId: "openclaw",
        model: "openclaw/default",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
      },
      accountContext: { type: "PERSONAL" },
      deliveryPolicy: "auto",
      worktreeIntent: null,
    });

    // Collect frames until the turn returns to idle, validating every one
    // against the canonical server-frame schema.
    const kinds: string[] = [];
    const deltas: string[] = [];
    const runtimeEventTypes: string[] = [];
    let sawIdle = false;
    let guard = 0;
    while (!sawIdle && guard < 40) {
      guard += 1;
      const frame = chatSubscribeServerFrameSchema.parse(await session.next());
      kinds.push(frame.kind);
      if (frame.kind === "blockDelta") {
        runtimeEventTypes.push(frame.event.type);
        if (frame.event.type === "text.delta") {
          deltas.push(frame.event.delta);
        }
      }
      if (frame.kind === "turnStateChanged" && frame.runStatus === "idle") {
        sawIdle = true;
      }
    }

    expect(kinds).toContain("actionAck");
    expect(kinds).toContain("messageAccepted");
    expect(kinds).toContain("eventAppended");
    expect(runtimeEventTypes).toContain("tool_call.started");
    expect(runtimeEventTypes).toContain("tool_call.completed");
    expect(deltas.join("")).toBe("Hello from OpenClaw");
    expect(lastGatewayPrompt).toBe("Say hello");

    // A second subscriber sees the persisted history in its snapshot.
    const second = await dialStream();
    second.send({
      kind: "open",
      token: "test-bearer",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
    });
    expect(frameKind(await second.next())).toBe("openAck");
    second.send({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-1", chatId: "chat-1" },
    });
    const replay = chatSubscribeServerFrameSchema.parse(await second.next());
    if (replay.kind === "snapshot") {
      expect(replay.snapshot.chat.messages).toHaveLength(2);
      const assistant = replay.snapshot.chat.messages[1];
      expect(assistant.role).toBe("assistant");
      if (assistant.role === "assistant") {
        expect(assistant.blocks.map((block) => block.type)).toEqual([
          "tool_call",
          "text",
        ]);
        const toolBlock = assistant.blocks[0];
        if (toolBlock.type === "tool_call") {
          expect(toolBlock.toolName).toBe("read_file");
          expect(toolBlock.status).toBe("completed");
        }
        const block = assistant.blocks[1];
        expect(block.type).toBe("text");
        if (block.type === "text") {
          expect(block.text).toBe("Hello from OpenClaw");
        }
      }
    } else {
      throw new Error("expected a snapshot frame");
    }
    second.close();
    session.close();
  }, 20_000);

  it("answers ping with pong inside a chat subscription", async () => {
    const session = await dialStream();
    session.send({
      kind: "open",
      token: "test-bearer",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
    });
    await session.next();
    session.send({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-1", chatId: "chat-ping" },
    });
    await session.next(); // snapshot
    session.send({ kind: "ping", hasBinaryPayload: false });
    expect(frameKind(await session.next())).toBe("pong");
    session.close();
  });
});

describe("chat helpers", () => {
  it("flattens json-content to prompt text", () => {
    expect(
      promptTextFromContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
          { type: "paragraph", content: [{ type: "text", text: "world" }] },
        ],
      }),
    ).toBe("hello world");
  });

  it("diffs cumulative deltaText payloads", () => {
    expect(extractTextDelta({ deltaText: "Hello" }, "")).toBe("Hello");
    expect(extractTextDelta({ deltaText: "Hello world" }, "Hello")).toBe(
      " world",
    );
    expect(extractTextDelta({ delta: "!" }, "Hello world")).toBe("!");
    expect(extractTextDelta({ other: 1 }, "x")).toBe("");
  });
});
