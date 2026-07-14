import {
  gitSubscribeStatusRequestSchema,
  type GitSubscribeStatusEvent,
} from "@cic/protocol/host/git-schemas";
import { gitStatusSnapshot } from "./git-service";

/**
 * `git.subscribeStatus@1.0` sessions.
 *
 * Ref-counted per running directory: the first subscriber starts a 5s poll
 * (ADR-0003 - fixed cadence, no client knob), later subscribers share it,
 * and the poll stops when the last one unsubscribes. Each subscriber gets a
 * `snapshot` event immediately; `updated` events fire only when the
 * fingerprint moves, carrying the union of paths that entered or left the
 * changeset (`changedPaths`).
 */
type GitStatusEmitter = (event: GitSubscribeStatusEvent) => void;

const POLL_INTERVAL_MS = 5_000;

interface DirectoryPollState {
  readonly runningDir: string;
  readonly emitters: Set<GitStatusEmitter>;
  timer: NodeJS.Timeout | null;
  polling: boolean;
  lastFingerprint: string | null;
  lastPaths: ReadonlySet<string>;
}

export class GitStatusBroadcaster {
  private readonly directories = new Map<string, DirectoryPollState>();

  async subscribe(input: {
    readonly params: unknown;
    readonly emit: GitStatusEmitter;
  }): Promise<GitStatusSubscription | null> {
    const open = gitSubscribeStatusRequestSchema.safeParse(input.params);
    if (!open.success) {
      return null;
    }
    const runningDir = open.data.runningDir;
    let state = this.directories.get(runningDir);
    if (state === undefined) {
      state = {
        runningDir,
        emitters: new Set(),
        timer: null,
        polling: false,
        lastFingerprint: null,
        lastPaths: new Set(),
      };
      this.directories.set(runningDir, state);
    }
    state.emitters.add(input.emit);
    if (state.timer === null) {
      state.timer = setInterval(() => {
        void this.poll(state);
      }, POLL_INTERVAL_MS);
    }

    const pollStartedAtMs = Date.now();
    const snapshot = await gitStatusSnapshot(runningDir);
    state.lastFingerprint = snapshot.fingerprint;
    state.lastPaths = new Set(snapshot.files.map((file) => file.path));
    input.emit({
      type: "snapshot",
      runningDir: snapshot.runningDir,
      headSha: snapshot.headSha,
      branch: snapshot.branch,
      files: snapshot.files,
      fingerprint: snapshot.fingerprint,
      repoMode: snapshot.repoMode,
      repoState: snapshot.repoState,
      pollStartedAtMs,
    });
    return new GitStatusSubscription(this, state, input.emit);
  }

  release(state: DirectoryPollState, emit: GitStatusEmitter): void {
    state.emitters.delete(emit);
    if (state.emitters.size === 0) {
      if (state.timer !== null) {
        clearInterval(state.timer);
        state.timer = null;
      }
      this.directories.delete(state.runningDir);
    }
  }

  private async poll(state: DirectoryPollState): Promise<void> {
    if (state.polling || state.emitters.size === 0) {
      return;
    }
    state.polling = true;
    const pollStartedAtMs = Date.now();
    const snapshot = await gitStatusSnapshot(state.runningDir);
    state.polling = false;
    if (snapshot.fingerprint === state.lastFingerprint) {
      return;
    }
    const paths = new Set(snapshot.files.map((file) => file.path));
    const changedPaths = [
      ...new Set([
        ...[...paths].filter((path) => !state.lastPaths.has(path)),
        ...[...state.lastPaths].filter((path) => !paths.has(path)),
        // Paths present in both may still have changed content; the
        // fingerprint moved, so report every current path as affected when
        // no membership change explains it.
        ...(paths.size === state.lastPaths.size ? paths : []),
      ]),
    ];
    state.lastFingerprint = snapshot.fingerprint;
    state.lastPaths = paths;
    const event: GitSubscribeStatusEvent = {
      type: "updated",
      runningDir: snapshot.runningDir,
      headSha: snapshot.headSha,
      branch: snapshot.branch,
      files: snapshot.files,
      fingerprint: snapshot.fingerprint,
      repoMode: snapshot.repoMode,
      repoState: snapshot.repoState,
      changedPaths,
      pollStartedAtMs,
    };
    for (const emitter of state.emitters) {
      emitter(event);
    }
  }
}

export class GitStatusSubscription {
  private readonly broadcaster: GitStatusBroadcaster;
  private readonly state: DirectoryPollState;
  private readonly emit: GitStatusEmitter;

  constructor(
    broadcaster: GitStatusBroadcaster,
    state: DirectoryPollState,
    emit: GitStatusEmitter,
  ) {
    this.broadcaster = broadcaster;
    this.state = state;
    this.emit = emit;
  }

  dispose(): void {
    this.broadcaster.release(this.state, this.emit);
  }
}
