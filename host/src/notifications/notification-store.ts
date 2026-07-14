import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import {
  notificationsSubscribeClientFrameSchema,
  type NotificationsSubscribeServerFrame,
} from "@cic/protocol/host/notifications/subscribe";
import { hostHomeDir } from "../pid-file";

/**
 * `notifications.subscribe@1.0` sessions: one per-user notifications Y.Doc,
 * relayed CRDT-style exactly like the epic docs (client `applyUpdate` pushes
 * apply + fan out to every other subscriber; host-side writes would ride the
 * same `update` event). The doc is flushed (debounced) to
 * `~/.cic/host[/env]/open-host-notifications/<userId>.yupdate` so unread
 * state survives restarts. The open host never mints notifications of its
 * own yet - the doc starts empty and clients own its contents.
 */
type NotificationsEmitter = (
  frame: NotificationsSubscribeServerFrame,
  binary: Uint8Array | null,
) => void;

interface UserDocState {
  readonly userId: string;
  readonly doc: Y.Doc;
  readonly emitters: Set<NotificationsEmitter>;
  flushTimer: NodeJS.Timeout | null;
}

const FLUSH_DEBOUNCE_MS = 500;

export class NotificationStore {
  private readonly environment: string;
  private readonly users = new Map<string, UserDocState>();

  constructor(environment: string) {
    this.environment = environment;
  }

  async subscribe(input: {
    readonly userId: string;
    readonly emit: NotificationsEmitter;
  }): Promise<NotificationsSubscription> {
    const state = await this.load(input.userId);
    state.emitters.add(input.emit);
    return new NotificationsSubscription(state, input.emit);
  }

  private async load(userId: string): Promise<UserDocState> {
    const existing = this.users.get(userId);
    if (existing !== undefined) {
      return existing;
    }
    const state: UserDocState = {
      userId,
      doc: new Y.Doc(),
      emitters: new Set(),
      flushTimer: null,
    };
    const persisted = await this.readBlob(userId);
    if (persisted !== null) {
      Y.applyUpdate(state.doc, persisted);
    }
    state.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.scheduleFlush(state);
      for (const emitter of state.emitters) {
        if (emitter !== origin) {
          emitter({ kind: "update", hasBinaryPayload: true }, update);
        }
      }
    });
    const raced = this.users.get(userId);
    if (raced !== undefined) {
      return raced;
    }
    this.users.set(userId, state);
    return state;
  }

  private scheduleFlush(state: UserDocState): void {
    if (state.flushTimer !== null) {
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void this.writeBlob(state.userId, Y.encodeStateAsUpdate(state.doc));
    }, FLUSH_DEBOUNCE_MS);
  }

  private blobPath(userId: string): string {
    const safe = userId.replace(/[^A-Za-z0-9._-]/g, "_");
    return join(
      hostHomeDir(this.environment),
      "open-host-notifications",
      `${safe}.yupdate`,
    );
  }

  private async readBlob(userId: string): Promise<Uint8Array | null> {
    try {
      const raw = await readFile(this.blobPath(userId));
      return new Uint8Array(raw);
    } catch {
      return null;
    }
  }

  private async writeBlob(userId: string, bytes: Uint8Array): Promise<void> {
    try {
      await mkdir(
        join(hostHomeDir(this.environment), "open-host-notifications"),
        { recursive: true },
      );
      await writeFile(this.blobPath(userId), bytes);
    } catch {
      // Best-effort persistence; the in-memory doc stays authoritative.
    }
  }
}

export class NotificationsSubscription {
  private readonly state: UserDocState;
  private readonly emit: NotificationsEmitter;

  constructor(state: UserDocState, emit: NotificationsEmitter) {
    this.state = state;
    this.emit = emit;
  }

  dispose(): void {
    this.state.emitters.delete(this.emit);
  }

  emitSnapshot(): void {
    this.emit(
      {
        kind: "snapshot",
        meta: { schemaVersion: "1" },
        hasBinaryPayload: true,
      },
      Y.encodeStateAsUpdate(this.state.doc),
    );
  }

  handleFrame(parsed: unknown, binary: Uint8Array | null): void {
    const frame = notificationsSubscribeClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      return;
    }
    if (frame.data.kind === "ping") {
      this.emit({ kind: "pong", hasBinaryPayload: false }, null);
      return;
    }
    if (frame.data.kind === "applyUpdate" && binary !== null) {
      // Origin-tagged so the doc's `update` listener skips the pusher.
      Y.applyUpdate(this.state.doc, binary, this.emit);
    }
  }
}
