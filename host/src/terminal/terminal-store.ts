import type { Subprocess } from "bun";
import {
  terminalSubscribeClientFrameSchema,
  terminalSubscribeOpenRequestSchema,
  type TerminalSubscribeServerFrame,
} from "@cic/protocol/host/terminal/subscribe";
import type {
  CreateTerminalRequest,
  TerminalSessionInfo,
} from "@cic/protocol/host/terminal/unary-schemas";

/**
 * Host-owned PTY sessions behind `terminal.*`.
 *
 * Each session is a real pseudo-terminal via `Bun.spawn`'s `terminal`
 * option: the shell's output arrives through the terminal `data` callback,
 * is appended to a rolling in-memory scrollback (PTYs don't survive host
 * restarts, so neither does scrollback), and fans out to every attached
 * subscriber as text `data` frames — valid at every shipped minor of
 * `terminal.subscribe`, so no per-subscriber version branching is needed.
 *
 * Multiple viewers may attach to one session. The host enforces
 * `effectiveCols = min(cols across viewers)` (rows likewise): on attach,
 * detach, and client `resize` the effective size is recomputed, the PTY is
 * resized, and a `resized` frame is broadcast so every xterm locks to the
 * shared grid.
 *
 * Exited sessions stay listed (status `exited` + exitCode) until an
 * explicit `terminal.kill` evicts them, so the renderer can show
 * "Process exited — Restart" instead of silently spawning a fresh shell.
 */
type TerminalEmitter = (frame: TerminalSubscribeServerFrame) => void;

const MAX_SCROLLBACK_BYTES = 2_000_000;

interface ViewerState {
  cols: number;
  rows: number;
}

interface SessionState {
  readonly info: TerminalSessionInfo;
  proc: Subprocess | null;
  scrollback: string;
  killedByRequest: boolean;
  readonly viewers: Map<TerminalEmitter, ViewerState>;
}

export class TerminalStore {
  private readonly sessions = new Map<string, SessionState>();

  create(request: CreateTerminalRequest): TerminalSessionInfo {
    const existing = this.sessions.get(request.desiredSessionId);
    if (existing !== undefined && existing.info.status === "running") {
      // Stable across reconnect attempts within one tile lifetime: an
      // already-running PTY under the renderer-authoritative id is THE
      // session, not a conflict.
      return existing.info;
    }
    if (existing !== undefined) {
      this.sessions.delete(request.desiredSessionId);
    }

    const shellCommand = request.shellCommand ?? Bun.env.SHELL ?? "/bin/bash";
    const shellArgs = request.shellArgs ?? [];
    const info: TerminalSessionInfo = {
      sessionId: request.desiredSessionId,
      epicId: request.epicId,
      sessionKind: request.sessionKind,
      cwd: request.cwd,
      shellCommand,
      shellArgs,
      cols: request.cols,
      rows: request.rows,
      status: "running",
      exitCode: null,
      exitReason: null,
      createdAt: Date.now(),
      title: null,
      activeProcessName: null,
    };
    const state: SessionState = {
      info,
      proc: null,
      scrollback: "",
      killedByRequest: false,
      viewers: new Map(),
    };

    const decoder = new TextDecoder();
    const proc = Bun.spawn([shellCommand, ...shellArgs], {
      cwd: request.cwd,
      env: { ...Bun.env, TERM: "xterm-256color" },
      terminal: {
        cols: request.cols,
        rows: request.rows,
        data: (...args: unknown[]) => {
          const chunk = args.find(
            (arg): arg is Uint8Array => arg instanceof Uint8Array,
          );
          if (chunk === undefined) {
            return;
          }
          const text = decoder.decode(chunk);
          state.scrollback = (state.scrollback + text).slice(
            -MAX_SCROLLBACK_BYTES,
          );
          for (const emitter of state.viewers.keys()) {
            emitter({
              kind: "data",
              hasBinaryPayload: false,
              sessionId: info.sessionId,
              chunk: text,
            });
          }
        },
      },
    });
    state.proc = proc;
    void proc.exited.then((exitCode) => {
      info.status = "exited";
      info.exitCode = exitCode;
      info.exitReason = state.killedByRequest ? "killed" : "process-exit";
      for (const emitter of state.viewers.keys()) {
        emitter({
          kind: "exit",
          hasBinaryPayload: false,
          sessionId: info.sessionId,
          exitCode,
        });
      }
    });

    this.sessions.set(info.sessionId, state);
    return info;
  }

  /**
   * Observes a session's process exit (used by the worktree setup runner to
   * flip binding setupState). Fires immediately for an already-exited
   * session; no-op for an unknown id.
   */
  watchExit(sessionId: string, onExit: (exitCode: number) => void): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return;
    }
    if (state.info.status === "exited") {
      onExit(state.info.exitCode ?? 0);
      return;
    }
    void state.proc?.exited.then((exitCode) => {
      onExit(exitCode);
    });
  }

  list(epicId: string): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .filter((state) => state.info.epicId === epicId)
      .map((state) => state.info);
  }

  kill(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return false;
    }
    const wasRunning = state.info.status === "running";
    this.terminate(state);
    this.sessions.delete(sessionId);
    return wasRunning;
  }

  /** Kills every PTY (host shutdown). */
  killAll(): void {
    for (const state of this.sessions.values()) {
      this.terminate(state);
    }
    this.sessions.clear();
  }

  /**
   * Hard-terminates a session's process tree. Closing the PTY delivers the
   * conventional SIGHUP, but an interactive shell can ignore both SIGHUP
   * and SIGTERM, so an explicit kill is a user-initiated close's contract —
   * SIGKILL keeps "close terminal" deterministic.
   */
  private terminate(state: SessionState): void {
    state.killedByRequest = true;
    if (state.info.status !== "running") {
      return;
    }
    state.proc?.terminal?.close();
    state.proc?.kill("SIGKILL");
  }

  rename(sessionId: string, title: string): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.info.title === title) {
      return false;
    }
    state.info.title = title;
    for (const emitter of state.viewers.keys()) {
      emitter({
        kind: "sessionUpdated",
        hasBinaryPayload: false,
        sessionId,
        session: state.info,
      });
    }
    return true;
  }

  subscribe(input: {
    readonly params: unknown;
    readonly emit: TerminalEmitter;
  }): TerminalSubscription | null {
    const open = terminalSubscribeOpenRequestSchema.safeParse(input.params);
    if (!open.success) {
      return null;
    }
    const state = this.sessions.get(open.data.sessionId);
    if (state === undefined) {
      return null;
    }
    state.viewers.set(input.emit, {
      cols: open.data.cols,
      rows: open.data.rows,
    });
    // The min() recompute must complete before the snapshot so its
    // session.cols/rows already reflect this viewer's attach.
    this.applyEffectiveSize(state);
    return new TerminalSubscription(this, state, input.emit);
  }

  detach(state: SessionState, emit: TerminalEmitter): void {
    if (state.viewers.delete(emit) && state.viewers.size > 0) {
      this.applyEffectiveSize(state);
    }
  }

  /**
   * Recomputes the shared grid (min cols/rows across viewers), resizes the
   * PTY, and broadcasts `resized` when the effective size moved.
   */
  applyEffectiveSize(state: SessionState): void {
    if (state.viewers.size === 0) {
      return;
    }
    let cols = Number.MAX_SAFE_INTEGER;
    let rows = Number.MAX_SAFE_INTEGER;
    for (const viewer of state.viewers.values()) {
      cols = Math.min(cols, viewer.cols);
      rows = Math.min(rows, viewer.rows);
    }
    if (cols === state.info.cols && rows === state.info.rows) {
      return;
    }
    state.info.cols = cols;
    state.info.rows = rows;
    if (state.info.status === "running") {
      state.proc?.terminal?.resize(cols, rows);
    }
    for (const emitter of state.viewers.keys()) {
      emitter({
        kind: "resized",
        hasBinaryPayload: false,
        sessionId: state.info.sessionId,
        cols,
        rows,
      });
    }
  }
}

export class TerminalSubscription {
  private readonly store: TerminalStore;
  private readonly state: SessionState;
  private readonly emit: TerminalEmitter;

  constructor(
    store: TerminalStore,
    state: SessionState,
    emit: TerminalEmitter,
  ) {
    this.store = store;
    this.state = state;
    this.emit = emit;
  }

  dispose(): void {
    this.store.detach(this.state, this.emit);
  }

  emitSnapshot(): void {
    this.emit({
      kind: "snapshot",
      hasBinaryPayload: false,
      sessionId: this.state.info.sessionId,
      session: this.state.info,
      scrollback: this.state.scrollback,
      // The open host applies no ack-credit backpressure, so tell the
      // client not to bother sending `ack` frames.
      ackCreditSupported: false,
    });
  }

  handleFrame(parsed: unknown): void {
    const frame = terminalSubscribeClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      return;
    }
    const data = frame.data;
    if (data.kind === "ping") {
      this.emit({ kind: "pong", hasBinaryPayload: false });
      return;
    }
    if (data.kind === "ack") {
      // Fire-and-forget credit signal; no backpressure tally to update.
      return;
    }
    if (this.state.info.status !== "running") {
      this.ack(data.clientActionId, data.kind, {
        status: "rejected",
        reason: "the terminal session has exited",
        code: "SESSION_EXITED",
      });
      return;
    }
    if (data.kind === "write") {
      this.state.proc?.terminal?.write(data.data);
      this.ack(data.clientActionId, "write", {
        status: "accepted",
        reason: null,
        code: null,
      });
      return;
    }
    // resize: update this viewer's grid and recompute the shared min().
    const viewer = this.state.viewers.get(this.emit);
    if (viewer !== undefined) {
      viewer.cols = data.cols;
      viewer.rows = data.rows;
      this.store.applyEffectiveSize(this.state);
    }
    this.ack(data.clientActionId, "resize", {
      status: "accepted",
      reason: null,
      code: null,
    });
  }

  private ack(
    clientActionId: string,
    action: "write" | "resize",
    outcome: {
      readonly status: "accepted" | "rejected";
      readonly reason: string | null;
      readonly code: string | null;
    },
  ): void {
    // actionAck frames are addressed only to the sender.
    this.emit({
      kind: "actionAck",
      hasBinaryPayload: false,
      sessionId: this.state.info.sessionId,
      clientActionId,
      action,
      status: outcome.status,
      reason: outcome.reason,
      code: outcome.code,
    });
  }
}
