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

/** Reads a chat card the way the GUI projector does: nested epic map. */
function readChat(
  doc: Y.Doc,
  chatId: string,
): Record<string, unknown> | undefined {
  const chats = doc.getMap("epic").get("chats");
  if (!(chats instanceof Y.Map)) {
    return undefined;
  }
  const entry = chats.get(chatId);
  return entry instanceof Y.Map
    ? (entry.toJSON() as Record<string, unknown>)
    : undefined;
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

    // The folded chat seed is visible to an epic.subscribe snapshot, in the
    // nested epic-map shape the GUI projector reads.
    const doc = await snapshotEpicDoc("epic-u1");
    expect(readChat(doc, "chat-u1")).toMatchObject({
      id: "chat-u1",
      title: "First chat",
    });
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
    expect(readChat(doc, "chat-u2")).toMatchObject({
      id: "chat-u2",
      title: "Later chat",
    });
  }, 20_000);

  it("updates titles and renames/deletes chats", async () => {
    await callRpc("epic.create", {
      epic: epicLight("epic-u3", "Original title"),
      repoIdentifiers: [],
      workspaces: [],
      chat: null,
    });
    const retitle = await callRpc("epic.updateTitle", {
      epicDelta: {
        id: "epic-u3",
        title: "Renamed epic",
        updatedAt: Date.now(),
      },
    });
    expect(retitle.error).toBeNull();
    expect(retitle.result).toMatchObject({ updated: true });
    const missing = await callRpc("epic.updateTitle", {
      epicDelta: { id: "nope", title: "x", updatedAt: Date.now() },
    });
    expect(missing.result).toMatchObject({ updated: false });

    await callRpc("epic.createChat", {
      epicId: "epic-u3",
      parentId: null,
      hostId: "open-host",
      title: "To rename",
      chatId: "chat-u3",
    });
    const renamed = await callRpc("epic.renameChat", {
      epicId: "epic-u3",
      chatId: "chat-u3",
      title: "Renamed chat",
    });
    expect(renamed.result).toMatchObject({ updated: true });
    let doc = await snapshotEpicDoc("epic-u3");
    expect(readChat(doc, "chat-u3")).toMatchObject({
      title: "Renamed chat",
      isTitleEditedByUser: true,
    });
    // The retitle also reached the doc header the canvas renders.
    expect(doc.getMap("epic").get("title")).toBe("Renamed epic");

    const deleted = await callRpc("epic.deleteChat", {
      epicId: "epic-u3",
      chatId: "chat-u3",
    });
    expect(deleted.result).toMatchObject({ deleted: true });
    doc = await snapshotEpicDoc("epic-u3");
    expect(readChat(doc, "chat-u3")).toBeUndefined();
  }, 20_000);

  it("creates, mutates, and trashes artifacts in the epic doc", async () => {
    await callRpc("epic.create", {
      epic: epicLight("epic-u5", "Artifact epic"),
      repoIdentifiers: [],
      workspaces: [],
      chat: null,
    });
    const created = await callRpc("epic.createArtifact", {
      epicId: "epic-u5",
      parentId: null,
      artifactType: "ticket",
      title: "Fix the flaky test",
    });
    expect(created.error).toBeNull();
    const artifactId = (created.result as { artifactId: string }).artifactId;
    expect(artifactId.length).toBeGreaterThan(0);

    let doc = await snapshotEpicDoc("epic-u5");
    const readArtifact = (
      target: Y.Doc,
      id: string,
    ): Record<string, unknown> | undefined => {
      const artifacts = target.getMap("epic").get("artifacts");
      if (!(artifacts instanceof Y.Map)) {
        return undefined;
      }
      const entry = artifacts.get(id);
      return entry instanceof Y.Map
        ? (entry.toJSON() as Record<string, unknown>)
        : undefined;
    };
    expect(readArtifact(doc, artifactId)).toMatchObject({
      id: artifactId,
      kind: "ticket",
      title: "Fix the flaky test",
      parentId: null,
      status: 0,
      createdManually: true,
    });

    const renamed = await callRpc("epic.renameArtifact", {
      epicId: "epic-u5",
      artifactId,
      title: "Fix the flaky terminal test",
    });
    expect(renamed.result).toEqual({ updated: true });
    const statusUpdated = await callRpc("epic.updateArtifactStatus", {
      epicId: "epic-u5",
      artifactId,
      artifactType: "ticket",
      status: 2,
    });
    expect(statusUpdated.result).toEqual({ updated: true });
    doc = await snapshotEpicDoc("epic-u5");
    expect(readArtifact(doc, artifactId)).toMatchObject({
      title: "Fix the flaky terminal test",
      status: 2,
    });

    const missing = await callRpc("epic.renameArtifact", {
      epicId: "epic-u5",
      artifactId: "does-not-exist",
      title: "x",
    });
    expect(missing.result).toEqual({ updated: false });

    const deleted = await callRpc("epic.deleteArtifact", {
      epicId: "epic-u5",
      artifactId,
    });
    expect(deleted.result).toEqual({ deleted: true });
    doc = await snapshotEpicDoc("epic-u5");
    expect(readArtifact(doc, artifactId)).toBeUndefined();
    const trash = doc.getMap("epic").get("deletedArtifacts");
    expect(trash instanceof Y.Map).toBe(true);
    if (trash instanceof Y.Map) {
      const entry = trash.get(artifactId);
      expect(entry instanceof Y.Map).toBe(true);
      if (entry instanceof Y.Map) {
        expect(entry.toJSON()).toMatchObject({
          kind: "ticket",
          title: "Fix the flaky terminal test",
          status: 2,
        });
      }
    }

    const resolved = await callRpc("epic.resolveArtifactByPath", {
      epicId: "epic-u5",
      filePath: "docs/spec.md",
    });
    expect(resolved.result).toEqual({ artifact: null });
  }, 20_000);

  it("runs the comment-thread lifecycle against the local store", async () => {
    const ref = {
      epicId: "epic-u5",
      artifactType: "spec",
      artifactId: "artifact-c1",
    };
    const paragraph = (text: string): Record<string, unknown> => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });

    const created = await callRpc("epic.createCommentThread", {
      ...ref,
      content: paragraph("First comment"),
      quotedText: "the quoted span",
    });
    expect(created.error).toBeNull();
    const threadId = (created.result as { threadId: string }).threadId;

    const replied = await callRpc("epic.replyToCommentThread", {
      ...ref,
      threadId,
      content: paragraph("A reply"),
    });
    expect(replied.result).toEqual({ ok: true });

    let listed = await callRpc("epic.listCommentThreads", ref);
    expect(listed.error).toBeNull();
    const threads = (
      listed.result as {
        threads: Array<{
          threadId: string;
          resolved: boolean;
          comments: Array<{ commentId: string }>;
          data: { quotedText?: string };
        }>;
      }
    ).threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe(threadId);
    expect(threads[0].comments).toHaveLength(2);
    expect(threads[0].data.quotedText).toBe("the quoted span");
    const replyId = threads[0].comments[1].commentId;

    const edited = await callRpc("epic.editComment", {
      ...ref,
      threadId,
      commentId: replyId,
      content: paragraph("An edited reply"),
    });
    expect(edited.result).toEqual({ ok: true });

    const resolvedResult = await callRpc("epic.setCommentThreadResolved", {
      ...ref,
      threadId,
      resolved: true,
    });
    expect(resolvedResult.result).toEqual({ ok: true });

    const deletedComment = await callRpc("epic.deleteComment", {
      ...ref,
      threadId,
      commentId: replyId,
    });
    expect(deletedComment.result).toEqual({ ok: true });

    listed = await callRpc("epic.listCommentThreads", ref);
    const after = (
      listed.result as {
        threads: Array<{ resolved: boolean; comments: unknown[] }>;
      }
    ).threads;
    expect(after[0].resolved).toBe(true);
    expect(after[0].comments).toHaveLength(1);

    const deletedThread = await callRpc("epic.deleteCommentThread", {
      ...ref,
      threadId,
    });
    expect(deletedThread.result).toEqual({ ok: true });
    listed = await callRpc("epic.listCommentThreads", ref);
    expect((listed.result as { threads: unknown[] }).threads).toEqual([]);

    // Unknown thread ids surface as structured RPC errors.
    const missing = await callRpc("epic.replyToCommentThread", {
      ...ref,
      threadId: "nope",
      content: paragraph("x"),
    });
    expect(missing.result).toBeNull();
    expect(missing.error).not.toBeNull();
  }, 20_000);

  it("suggests indexed epics for @-mentions", async () => {
    const mentions = await callRpc("epic.mentionEpics", {
      query: "second",
      limit: 10,
    });
    expect(mentions.error).toBeNull();
    expect(mentions.result).toMatchObject({
      entries: [
        {
          kind: "epic",
          id: "epic:epic-u2",
          token: "epic:epic-u2",
          epicId: "epic-u2",
          label: "Second epic",
        },
      ],
    });
  }, 20_000);

  it("stamps repo/workspace associations and batch-deletes epics", async () => {
    const create = await callRpc("epic.create", {
      epic: epicLight("epic-u4", "Associated epic"),
      repoIdentifiers: [{ owner: "cosmicmabel", repo: "traycer" }],
      workspaces: [{ workspacePath: "/home/user/traycer" }],
      chat: null,
    });
    expect(create.error).toBeNull();
    expect(create.result).toMatchObject({
      task: {
        epic: {
          repos: [
            {
              task: { taskId: "epic-u4", taskType: "epic" },
              repoIdentifier: { owner: "cosmicmabel", repo: "traycer" },
            },
          ],
          workspaces: [
            { workspacePath: "/home/user/traycer", hostId: "open-host" },
          ],
        },
      },
    });

    const collaborators = await callRpc("epic.listCollaborators", {
      epicId: "epic-u4",
    });
    expect(collaborators.result).toMatchObject({
      collaborators: [],
      collaboratorsAvailable: false,
    });

    const batch = await callRpc("epic.batchDelete", {
      ids: ["epic-u4", "epic-never-existed"],
    });
    expect(batch.error).toBeNull();
    expect(batch.result).toMatchObject({
      results: [
        { taskId: "epic-u4", success: true },
        { taskId: "epic-never-existed", success: false },
      ],
    });

    const list = await callRpc("epic.listTasks", {
      limit: 50,
      filters: null,
      extensionPhaseVersion: "1",
      extensionEpicVersion: "1",
    });
    const ids = (
      list.result as {
        tasks: Array<{ epic?: { light: { id: string } } | null }>;
      }
    ).tasks.map((task) => task.epic?.light.id);
    expect(ids).not.toContain("epic-u4");
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
