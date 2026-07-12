import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  worktreeDeleteByPathOpenRequestSchema,
  type WorktreeDeleteByPathServerFrame,
} from "@traycer/protocol/host/worktree-delete-stream";
import {
  workspaceScriptsSchema,
  type OsScript,
} from "@traycer/protocol/host/worktree-schemas";
import { removeWorktreeDir, resolveOsScript } from "./worktree-mutations";

/**
 * `worktree.deleteByPath@1.0` sessions (Settings ▸ Worktrees): validate →
 * teardown (streamed as `output` frames) → `git worktree remove --force`
 * (with the orphan `rm -rf` fallback inside `removeWorktreeDir`) →
 * `complete`. The open host runs no busy-check registry yet, so nothing is
 * ever declined as in-use; a missing path fails before any phase.
 */
type DeleteEmitter = (frame: WorktreeDeleteByPathServerFrame) => void;

export class WorktreeDeleteStream {
  subscribe(input: {
    readonly params: unknown;
    readonly emit: DeleteEmitter;
  }): WorktreeDeleteSubscription | null {
    const open = worktreeDeleteByPathOpenRequestSchema.safeParse(input.params);
    if (!open.success) {
      return null;
    }
    return new WorktreeDeleteSubscription(
      open.data.worktreePath,
      open.data.scripts,
      input.emit,
    );
  }
}

export class WorktreeDeleteSubscription {
  private readonly worktreePath: string;
  private readonly scripts: { readonly teardown: OsScript } | null;
  private readonly emit: DeleteEmitter;
  private disposed = false;

  constructor(
    worktreePath: string,
    scripts: { readonly teardown: OsScript } | null,
    emit: DeleteEmitter,
  ) {
    this.worktreePath = worktreePath;
    this.scripts = scripts;
    this.emit = emit;
  }

  dispose(): void {
    this.disposed = true;
  }

  handleFrame(parsed: unknown): void {
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Reflect.get(parsed, "kind") === "ping"
    ) {
      this.emit({ kind: "pong", hasBinaryPayload: false });
    }
  }

  /** Runs the whole pipeline; fired (not awaited) right after subscribe. */
  async run(): Promise<void> {
    const info = await stat(this.worktreePath).catch(() => null);
    if (info === null || !info.isDirectory()) {
      this.emit({
        kind: "failed",
        reason: `worktree path does not exist on this host: ${this.worktreePath}`,
        hasBinaryPayload: false,
      });
      return;
    }
    const teardownCommand = await this.resolveTeardown();
    this.emit({
      kind: "started",
      hasTeardown: teardownCommand !== null,
      hasBinaryPayload: false,
    });
    if (teardownCommand !== null) {
      this.emit({
        kind: "phase",
        phase: "teardown",
        hasBinaryPayload: false,
      });
      await this.runTeardown(teardownCommand);
    }
    if (this.disposed) {
      return;
    }
    this.emit({ kind: "phase", phase: "remove", hasBinaryPayload: false });
    const deleted = await removeWorktreeDir(this.worktreePath);
    this.emit({ kind: "complete", deleted, hasBinaryPayload: false });
  }

  private async resolveTeardown(): Promise<string | null> {
    let teardown: OsScript | null = this.scripts?.teardown ?? null;
    if (teardown === null) {
      try {
        const raw = await Bun.file(
          join(this.worktreePath, ".traycer", "environment.json"),
        ).text();
        const parsed = workspaceScriptsSchema.safeParse(JSON.parse(raw));
        teardown = parsed.success ? parsed.data.teardown : null;
      } catch {
        teardown = null;
      }
    }
    if (teardown === null) {
      return null;
    }
    const command = resolveOsScript(teardown);
    return command.trim().length === 0 ? null : command;
  }

  private async runTeardown(command: string): Promise<void> {
    const child = Bun.spawn(["/bin/bash", "-lc", command], {
      cwd: this.worktreePath,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const pump = async (
      stream: ReadableStream<Uint8Array>,
      channel: "stdout" | "stderr",
    ): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        if (this.disposed) {
          return;
        }
        this.emit({
          kind: "output",
          channel,
          chunk: decoder.decode(chunk),
          hasBinaryPayload: false,
        });
      }
    };
    await Promise.all([
      pump(child.stdout, "stdout"),
      pump(child.stderr, "stderr"),
      child.exited,
    ]);
  }
}
