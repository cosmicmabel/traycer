// Runs under `bun test` — the host and the mock gateway are Bun.serve servers.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { chatSubscribeServerFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { startOpenHostServer, type RunningOpenHost } from "../server";

/**
 * Approval flow over `chat.subscribe`: the mock gateway emits an
 * `exec.approval.requested` event and HOLDS the `chat.send` response until
 * the host resolves the approval (`approval.resolve`), mirroring a gateway
 * that blocks the agent on the prompt. The test approves through the
 * canonical `approvalDecision` action and then sees the turn complete.
 */
interface MockGateway {
  readonly port: number | undefined;
  stop(closeActiveConnections: boolean): void;
}

let gateway: MockGateway;
let server: RunningOpenHost;
let resolveParams: unknown = null;
let pendingSendId: unknown = null;

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
          // Block the run on an approval prompt; the response to chat.send
          // is held until the operator decides.
          pendingSendId = id;
          ws.send(
            JSON.stringify({
              type: "event",
              event: "exec.approval.requested",
              payload: {
                id: "appr-1",
                command: "rm -rf ./dist",
                description: "Run rm -rf ./dist",
              },
            }),
          );
          return;
        }
        if (method === "approval.resolve") {
          resolveParams = Reflect.get(frame, "params");
          ws.send(JSON.stringify({ type: "res", id, ok: true, payload: {} }));
          ws.send(
            JSON.stringify({
              type: "event",
              event: "chat.delta",
              payload: { deltaText: "Removed dist" },
            }),
          );
          ws.send(
            JSON.stringify({
              type: "res",
              id: pendingSendId,
              ok: true,
              payload: {},
            }),
          );
        }
      },
    },
  });

  server = startOpenHostServer({
    port: 0,
    environment: `test-approvals-${process.pid}-${Date.now()}`,
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

describe("chat approvals backed by the OpenClaw gateway", () => {
  it("maps gateway approval prompts onto approvalRequested/approvalResolved", async () => {
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
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 3 },
        params: { epicId: "epic-a", chatId: "chat-a" },
      }),
    );
    const snapshot = chatSubscribeServerFrameSchema.parse(await next());
    if (snapshot.kind !== "snapshot") {
      throw new Error("expected a snapshot frame");
    }
    expect(snapshot.snapshot.pendingApprovals).toEqual([]);

    socket.send(
      JSON.stringify({
        kind: "send",
        epicId: "epic-a",
        chatId: "chat-a",
        hasBinaryPayload: false,
        clientActionId: "send-a1",
        messageId: "msg-a1",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Clean the build output" }],
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
      }),
    );

    // Drain frames until the approval prompt arrives.
    let approvalId = "";
    let guard = 0;
    while (approvalId === "" && guard < 30) {
      guard += 1;
      const frame = chatSubscribeServerFrameSchema.parse(await next());
      if (frame.kind === "approvalRequested") {
        expect(frame.approval).toMatchObject({
          approvalId: "appr-1",
          toolName: "exec",
          description: "Run rm -rf ./dist",
          kind: "tool",
        });
        approvalId = frame.approval.approvalId;
      }
    }
    expect(approvalId).toBe("appr-1");

    // Approve; the gateway then releases the held run.
    socket.send(
      JSON.stringify({
        kind: "approvalDecision",
        epicId: "epic-a",
        chatId: "chat-a",
        hasBinaryPayload: false,
        clientActionId: "appr-action-1",
        approvalId,
        decision: { approved: true },
      }),
    );

    const kinds: string[] = [];
    const deltas: string[] = [];
    let sawResolved = false;
    let sawAck = false;
    let sawIdle = false;
    guard = 0;
    while (!sawIdle && guard < 60) {
      guard += 1;
      const frame = chatSubscribeServerFrameSchema.parse(await next());
      kinds.push(frame.kind);
      if (
        frame.kind === "actionAck" &&
        frame.clientActionId === "appr-action-1"
      ) {
        expect(frame.action).toBe("approvalDecision");
        expect(frame.status).toBe("accepted");
        sawAck = true;
      }
      if (frame.kind === "approvalResolved") {
        expect(frame.approvalId).toBe("appr-1");
        expect(frame.decision.approved).toBe(true);
        sawResolved = true;
      }
      if (frame.kind === "blockDelta" && frame.event.type === "text.delta") {
        deltas.push(frame.event.delta);
      }
      if (frame.kind === "turnStateChanged" && frame.runStatus === "idle") {
        sawIdle = true;
      }
    }
    expect(sawAck).toBe(true);
    expect(sawResolved).toBe(true);
    expect(deltas.join("")).toBe("Removed dist");
    expect(resolveParams).toMatchObject({
      approvalId: "appr-1",
      approved: true,
    });
    socket.close(1000, "closed-by-caller");
  }, 30_000);
});
