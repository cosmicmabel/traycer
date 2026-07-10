import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import {
  epicSubscribeOpenRequestSchema,
  epicSubscribeClientFrameSchema,
  type EpicSubscribeServerFrame,
} from "@traycer/protocol/host/epic/subscribe";
import { hostHomeDir } from "../pid-file";

/**
 * `epic.subscribe@1.0` sessions over in-memory Y.Docs with best-effort disk
 * persistence.
 *
 * The contract multiplexes two doc scopes on one subscription: the root
 * metadata Epic doc (frames without `artifactRoomId`) and per-artifact-room
 * body docs (frames keyed by `artifactRoomId`). This host keeps one Y.Doc
 * per scope, applies client `applyUpdate` frames, and fans incremental
 * updates out to every other subscriber - classic CRDT relay, no
 * transformation. Awareness bytes are relayed opaquely (the host publishes
 * no presence of its own yet).
 *
 * Persistence: each root/room doc is flushed (debounced) to
 * `~/.traycer/host[/env]/open-host-epics/` as a Y update blob and reloaded
 * lazily, so epics survive host restarts. There is no cloud room behind
 * this host; `cloudSyncStatus` reports `connected` because the local doc IS
 * the authoritative copy - there is no upstream it could be behind.
 */
type EpicEmitter = (
  frame: EpicSubscribeServerFrame,
  binary: Uint8Array | null,
) => void;

interface RoomState {
  readonly doc: Y.Doc;
}

interface EpicState {
  readonly epicId: string;
  readonly doc: Y.Doc;
  readonly rooms: Map<string, RoomState>;
  readonly emitters: Set<EpicEmitter>;
  flushTimer: NodeJS.Timeout | null;
}

const FLUSH_DEBOUNCE_MS = 500;

export class EpicStore {
  private readonly environment: string;
  private readonly epics = new Map<string, EpicState>();

  constructor(environment: string) {
    this.environment = environment;
  }

  async subscribe(input: {
    readonly params: unknown;
    readonly emit: EpicEmitter;
  }): Promise<EpicSubscription | null> {
    const open = epicSubscribeOpenRequestSchema.safeParse(input.params);
    if (!open.success) {
      return null;
    }
    const state = await this.load(open.data.epicId);
    state.emitters.add(input.emit);
    return new EpicSubscription(this, state, input.emit);
  }

  private async load(epicId: string): Promise<EpicState> {
    const existing = this.epics.get(epicId);
    if (existing !== undefined) {
      return existing;
    }
    const state: EpicState = {
      epicId,
      doc: new Y.Doc(),
      rooms: new Map(),
      emitters: new Set(),
      flushTimer: null,
    };
    const persisted = await this.readBlob(rootBlobName(epicId));
    if (persisted !== null) {
      Y.applyUpdate(state.doc, persisted);
    }
    // Fan every root-doc change out through Y's own update event so client
    // pushes and host-side writes (epic.create/createChat seeding) share one
    // broadcast path. `origin` carries the pushing subscriber's emitter so
    // the echo back to the originator is suppressed.
    state.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.scheduleFlush(state);
      for (const emitter of state.emitters) {
        if (emitter !== origin) {
          emitter({ kind: "update", epicId, hasBinaryPayload: true }, update);
        }
      }
    });
    this.epics.set(epicId, state);
    return state;
  }

  /**
   * Host-side write path used by `epic.create` / `epic.createChat`: stores
   * the persisted chat record in the root doc's `chats` map so every epic
   * subscriber (current and future) projects the new chat card. Broadcast +
   * flush ride the doc's `update` event above.
   */
  async seedChat(
    epicId: string,
    chatRecord: {
      readonly id: string;
      readonly [key: string]: unknown;
    },
  ): Promise<void> {
    const state = await this.load(epicId);
    state.doc.getMap("chats").set(chatRecord.id, chatRecord);
  }

  async loadRoom(state: EpicState, artifactRoomId: string): Promise<RoomState> {
    const existing = state.rooms.get(artifactRoomId);
    if (existing !== undefined) {
      return existing;
    }
    const room: RoomState = { doc: new Y.Doc() };
    const persisted = await this.readBlob(
      roomBlobName(state.epicId, artifactRoomId),
    );
    if (persisted !== null) {
      Y.applyUpdate(room.doc, persisted);
    }
    state.rooms.set(artifactRoomId, room);
    return room;
  }

  scheduleFlush(state: EpicState): void {
    if (state.flushTimer !== null) {
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void this.flush(state);
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flush(state: EpicState): Promise<void> {
    await this.writeBlob(
      rootBlobName(state.epicId),
      Y.encodeStateAsUpdate(state.doc),
    );
    for (const [artifactRoomId, room] of state.rooms) {
      await this.writeBlob(
        roomBlobName(state.epicId, artifactRoomId),
        Y.encodeStateAsUpdate(room.doc),
      );
    }
  }

  private blobDir(): string {
    return join(hostHomeDir(this.environment), "open-host-epics");
  }

  private async readBlob(name: string): Promise<Uint8Array | null> {
    try {
      const raw = await readFile(join(this.blobDir(), name));
      return new Uint8Array(raw);
    } catch {
      return null;
    }
  }

  private async writeBlob(name: string, bytes: Uint8Array): Promise<void> {
    try {
      await mkdir(this.blobDir(), { recursive: true });
      await writeFile(join(this.blobDir(), name), bytes);
    } catch {
      // Persistence is best-effort; the in-memory doc stays authoritative.
    }
  }
}

/** Filesystem-safe blob names (epic/room ids are uuids in practice). */
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
function rootBlobName(epicId: string): string {
  return `${sanitize(epicId)}.root.yupdate`;
}
function roomBlobName(epicId: string, artifactRoomId: string): string {
  return `${sanitize(epicId)}.room.${sanitize(artifactRoomId)}.yupdate`;
}

export class EpicSubscription {
  private readonly store: EpicStore;
  private readonly state: EpicState;
  private readonly emit: EpicEmitter;

  constructor(store: EpicStore, state: EpicState, emit: EpicEmitter) {
    this.store = store;
    this.state = state;
    this.emit = emit;
  }

  dispose(): void {
    this.state.emitters.delete(this.emit);
  }

  /** Initial frames: root snapshot, sync status, and every known room. */
  emitSnapshot(): void {
    const epicId = this.state.epicId;
    this.emit(
      {
        kind: "snapshot",
        epicId,
        meta: {
          schemaVersion: "1",
          epicLight: null,
          permissionRole: "owner",
          repos: [],
          workspaces: [],
          repoMapping: [],
          workspaceFolders: [],
          unresolvedRepos: [],
          hostStateVectorBase64: stateVectorBase64(this.state.doc),
        },
        hasBinaryPayload: true,
      },
      Y.encodeStateAsUpdate(this.state.doc),
    );
    this.emit(
      {
        kind: "cloudSyncStatus",
        epicId,
        status: "connected",
        hasBinaryPayload: false,
      },
      null,
    );
    for (const [artifactRoomId, room] of this.state.rooms) {
      this.emit(
        {
          kind: "artifactRoomSnapshot",
          epicId,
          artifactRoomId,
          hostArtifactRoomStateVectorBase64: stateVectorBase64(room.doc),
          hasBinaryPayload: true,
        },
        Y.encodeStateAsUpdate(room.doc),
      );
    }
  }

  async handleFrame(parsed: unknown, binary: Uint8Array | null): Promise<void> {
    const frame = epicSubscribeClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      return;
    }
    const data = frame.data;
    const epicId = this.state.epicId;

    if (data.kind === "ping") {
      this.emit({ kind: "pong", hasBinaryPayload: false }, null);
      return;
    }
    if (binary === null) {
      // Every remaining client frame kind carries a binary payload.
      return;
    }

    if (data.kind === "applyUpdate") {
      // Origin-tagged so the doc's `update` listener (registered in `load`)
      // relays to every OTHER subscriber without echoing to this one.
      Y.applyUpdate(this.state.doc, binary, this.emit);
      return;
    }
    if (data.kind === "awareness") {
      this.broadcastToOthers(
        { kind: "awareness", epicId, hasBinaryPayload: true },
        binary,
      );
      return;
    }
    if (data.kind === "artifactRoomApplyUpdate") {
      const room = await this.store.loadRoom(this.state, data.artifactRoomId);
      Y.applyUpdate(room.doc, binary);
      this.store.scheduleFlush(this.state);
      this.broadcastToOthers(
        {
          kind: "artifactRoomUpdate",
          epicId,
          artifactRoomId: data.artifactRoomId,
          hostArtifactRoomStateVectorBase64: stateVectorBase64(room.doc),
          hasBinaryPayload: true,
        },
        binary,
      );
      return;
    }
    if (data.kind === "artifactRoomAwareness") {
      this.broadcastToOthers(
        {
          kind: "artifactRoomAwareness",
          epicId,
          artifactRoomId: data.artifactRoomId,
          hasBinaryPayload: true,
        },
        binary,
      );
    }
  }

  private broadcastToOthers(
    frame: EpicSubscribeServerFrame,
    binary: Uint8Array,
  ): void {
    for (const emitter of this.state.emitters) {
      if (emitter !== this.emit) {
        emitter(frame, binary);
      }
    }
  }
}

function stateVectorBase64(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString("base64");
}
