import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  workspaceScriptsSchema,
  type OsScript,
  type WorkspaceScripts,
  type WorktreeBindingEntry,
  type WorktreeBranchSelection,
  type WorktreeFolderIntent,
  type WorktreePerEntryResult,
} from "@cic/protocol/host/worktree-schemas";
import { runGit } from "../git/git-exec";
import { hostHomeDir } from "../pid-file";
import type { TerminalStore } from "../terminal/terminal-store";
import { parseRepoIdentifierFromRemoteUrl } from "../workspace/workspace-service";
import type { BindingOwnerKey, BindingStore } from "./binding-store";

/**
 * Worktree creation/import/delete for the open host.
 *
 * Worktrees are bucketed under the host home
 * (`<hostHome>/open-host-worktrees/<repo-bucket>/<branch>`), created with
 * plain `git worktree add`, and torn down with `git worktree remove --force`
 * (falling back to `rm -rf` for orphans git no longer tracks).
 *
 * Setup scripts run in REAL terminal sessions (the same PTY store behind
 * `terminal.*`), so the GUI can attach to the recorded
 * `setupTerminalSessionId` and watch the output live; the binding entry's
 * `setupState` transitions running → succeeded/failed on the shell's exit.
 *
 * Carry-uncommitted moves the source's TRACKED changes via a stash commit
 * (`git stash create` in the source, `git stash apply <sha>` in the new
 * worktree) — untracked files stay behind (documented limitation).
 */
const OK = [0];

export function worktreesRoot(environment: string): string {
  return join(hostHomeDir(environment), "open-host-worktrees");
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function resolveOsScript(script: OsScript): string {
  const platformValue =
    process.platform === "darwin"
      ? script.macos
      : process.platform === "win32"
        ? script.windows
        : script.linux;
  return platformValue ?? script.default;
}

async function readScriptsFile(root: string): Promise<WorkspaceScripts | null> {
  try {
    const raw = await Bun.file(join(root, ".cic", "environment.json")).text();
    const parsed = workspaceScriptsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeScriptsFile(
  root: string,
  scripts: { readonly setup: OsScript; readonly teardown: OsScript },
): Promise<boolean> {
  try {
    await mkdir(join(root, ".cic"), { recursive: true });
    await writeFile(
      join(root, ".cic", "environment.json"),
      JSON.stringify(
        {
          setup: scripts.setup,
          teardown: scripts.teardown,
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

interface CreatedWorktree {
  readonly worktreePath: string;
  readonly branch: string;
  readonly repoIdentifier: { owner: string; repo: string } | null;
}

/** `git worktree add` under the host bucket; returns null on git failure. */
export async function createWorktreeAt(
  environment: string,
  workspacePath: string,
  selection: WorktreeBranchSelection,
): Promise<CreatedWorktree | { readonly errorMessage: string }> {
  const remoteUrl = await runGit(
    workspacePath,
    ["remote", "get-url", "origin"],
    OK,
  );
  const repoIdentifier =
    remoteUrl === null ? null : parseRepoIdentifierFromRemoteUrl(remoteUrl);
  const bucket =
    repoIdentifier === null
      ? sanitize(basename(workspacePath))
      : `${sanitize(repoIdentifier.owner)}__${sanitize(repoIdentifier.repo)}`;
  const baseDir = join(worktreesRoot(environment), bucket);
  await mkdir(baseDir, { recursive: true }).catch(() => undefined);
  let worktreePath = join(baseDir, sanitize(selection.name));
  let suffix = 1;
  while ((await stat(worktreePath).catch(() => null)) !== null) {
    suffix += 1;
    worktreePath = join(baseDir, `${sanitize(selection.name)}-${suffix}`);
  }

  if (selection.type === "new") {
    const added = await runGit(
      workspacePath,
      ["worktree", "add", "-b", selection.name, worktreePath, selection.source],
      OK,
    );
    if (added === null) {
      return {
        errorMessage: `git worktree add -b ${selection.name} failed (does the branch already exist?)`,
      };
    }
    if (selection.carryUncommittedChanges) {
      // Tracked changes only: a stash commit made in the source applies
      // cleanly in the new worktree without touching the source checkout.
      const stashSha = await runGit(workspacePath, ["stash", "create"], OK);
      if (stashSha !== null && stashSha.length > 0) {
        await runGit(worktreePath, ["stash", "apply", stashSha], OK);
      }
    }
    return { worktreePath, branch: selection.name, repoIdentifier };
  }

  const added = await runGit(
    workspacePath,
    ["worktree", "add", worktreePath, selection.name],
    OK,
  );
  if (added === null) {
    return {
      errorMessage: `git worktree add for existing branch ${selection.name} failed (is it checked out elsewhere?)`,
    };
  }
  return { worktreePath, branch: selection.name, repoIdentifier };
}

export interface SetupRun {
  readonly setupState: "not_required" | "running";
  readonly terminalSessionId: string | null;
}

/**
 * Resolves the effective setup script for a fresh worktree (per-entry
 * override already written into the worktree, else whatever the checkout
 * carries) and runs it in a real terminal session. The exit callback flips
 * the binding row's setupState.
 */
export async function startSetupIfConfigured(input: {
  readonly terminals: TerminalStore;
  readonly bindings: BindingStore;
  readonly owner: BindingOwnerKey;
  readonly workspacePath: string;
  readonly worktreePath: string;
}): Promise<SetupRun> {
  const scripts = await readScriptsFile(input.worktreePath);
  const command = scripts === null ? "" : resolveOsScript(scripts.setup);
  if (command.trim().length === 0) {
    return { setupState: "not_required", terminalSessionId: null };
  }
  const sessionId = `worktree-setup-${sanitize(input.worktreePath)}-${Date.now()}`;
  input.terminals.create({
    epicId: input.owner.epicId,
    sessionKind: "terminal",
    tuiHarnessId: null,
    cwd: input.worktreePath,
    shellCommand: "/bin/bash",
    shellArgs: ["-lc", command],
    cols: 120,
    rows: 30,
    desiredSessionId: sessionId,
    worktreeBusyPaths: [input.worktreePath],
  });
  input.terminals.watchExit(sessionId, (exitCode) => {
    void input.bindings.update(input.owner, (binding) => ({
      ...binding,
      entries: binding.entries.map((entry) =>
        entry.workspacePath === input.workspacePath
          ? {
              ...entry,
              setupState: exitCode === 0 ? "succeeded" : "failed",
              setupExitCode: exitCode,
              setupFailedAt: exitCode === 0 ? null : Date.now(),
            }
          : entry,
      ),
    }));
  });
  return { setupState: "running", terminalSessionId: sessionId };
}

export function bindingEntry(input: {
  readonly workspacePath: string;
  readonly mode: "local" | "worktree";
  readonly repoIdentifier: { owner: string; repo: string } | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly isPrimary: boolean;
  readonly isImported: boolean;
  readonly setupState: WorktreeBindingEntry["setupState"];
  readonly setupTerminalSessionId: string | null;
}): WorktreeBindingEntry {
  return {
    workspacePath: input.workspacePath,
    mode: input.mode,
    repoIdentifier: input.repoIdentifier,
    worktreePath: input.worktreePath,
    branch: input.branch,
    isPrimary: input.isPrimary,
    isImported: input.isImported,
    setupState: input.setupState,
    setupTerminalSessionId: input.setupTerminalSessionId,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: Date.now(),
    ownedSubmodules: [],
  };
}

export function perEntryOk(
  workspacePath: string,
  worktreePath: string | null,
  branch: string | null,
): WorktreePerEntryResult {
  return { workspacePath, ok: true, worktreePath, branch, errorMessage: null };
}

export function perEntryFailed(
  workspacePath: string,
  errorMessage: string,
): WorktreePerEntryResult {
  return {
    workspacePath,
    ok: false,
    worktreePath: null,
    branch: null,
    errorMessage,
  };
}

export async function originRepoIdentifier(
  workspacePath: string,
): Promise<{ owner: string; repo: string } | null> {
  const remoteUrl = await runGit(
    workspacePath,
    ["remote", "get-url", "origin"],
    OK,
  );
  return remoteUrl === null
    ? null
    : parseRepoIdentifierFromRemoteUrl(remoteUrl);
}

export async function currentBranch(dir: string): Promise<string | null> {
  const name = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], OK);
  return name === null || name === "HEAD" ? null : name;
}

/**
 * Removes a worktree directory: `git worktree remove --force` against the
 * main repo (resolved from the worktree's own common dir), falling back to
 * a plain `rm -rf` for orphans git no longer tracks. Returns whether the
 * directory is gone afterwards.
 */
export async function removeWorktreeDir(
  worktreePath: string,
): Promise<boolean> {
  const commonDir = await runGit(
    worktreePath,
    ["rev-parse", "--git-common-dir"],
    OK,
  );
  if (commonDir !== null) {
    const mainRoot = dirname(commonDir);
    await runGit(mainRoot, ["worktree", "remove", "--force", worktreePath], OK);
    await runGit(mainRoot, ["worktree", "prune"], OK);
  }
  const remains = await stat(worktreePath).catch(() => null);
  if (remains !== null) {
    await rm(worktreePath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  return (await stat(worktreePath).catch(() => null)) === null;
}

/** Applies a folder intent for `worktree.create`; shared with import. */
export async function materializeIntent(input: {
  readonly environment: string;
  readonly terminals: TerminalStore;
  readonly bindings: BindingStore;
  readonly owner: BindingOwnerKey;
  readonly intent: WorktreeFolderIntent;
}): Promise<{
  readonly entry: WorktreeBindingEntry | null;
  readonly perEntry: WorktreePerEntryResult;
}> {
  const intent = input.intent;
  if (intent.kind === "local") {
    return {
      entry: bindingEntry({
        workspacePath: intent.workspacePath,
        mode: "local",
        repoIdentifier:
          intent.repoIdentifier ??
          (await originRepoIdentifier(intent.workspacePath)),
        worktreePath: null,
        branch: null,
        isPrimary: intent.isPrimary,
        isImported: false,
        setupState: "not_required",
        setupTerminalSessionId: null,
      }),
      perEntry: perEntryOk(intent.workspacePath, null, null),
    };
  }
  if (intent.kind === "import") {
    const info = await stat(intent.worktreePath).catch(() => null);
    if (info === null || !info.isDirectory()) {
      return {
        entry: null,
        perEntry: perEntryFailed(
          intent.workspacePath,
          `worktree path does not exist: ${intent.worktreePath}`,
        ),
      };
    }
    const branch = await currentBranch(intent.worktreePath);
    return {
      entry: bindingEntry({
        workspacePath: intent.workspacePath,
        mode: "worktree",
        repoIdentifier:
          intent.repoIdentifier ??
          (await originRepoIdentifier(intent.workspacePath)),
        worktreePath: intent.worktreePath,
        branch,
        isPrimary: intent.isPrimary,
        isImported: true,
        setupState: "not_required",
        setupTerminalSessionId: null,
      }),
      perEntry: perEntryOk(intent.workspacePath, intent.worktreePath, branch),
    };
  }

  const created = await createWorktreeAt(
    input.environment,
    intent.workspacePath,
    intent.branch,
  );
  if ("errorMessage" in created) {
    return {
      entry: null,
      perEntry: perEntryFailed(intent.workspacePath, created.errorMessage),
    };
  }
  if (intent.scripts !== null) {
    // The override reaches the worktree without ever writing the source
    // checkout; setup below reads it back from the worktree itself.
    await writeScriptsFile(created.worktreePath, intent.scripts);
  }
  const setup = await startSetupIfConfigured({
    terminals: input.terminals,
    bindings: input.bindings,
    owner: input.owner,
    workspacePath: intent.workspacePath,
    worktreePath: created.worktreePath,
  });
  return {
    entry: bindingEntry({
      workspacePath: intent.workspacePath,
      mode: "worktree",
      repoIdentifier: intent.repoIdentifier ?? created.repoIdentifier,
      worktreePath: created.worktreePath,
      branch: created.branch,
      isPrimary: intent.isPrimary,
      isImported: false,
      setupState: setup.setupState,
      setupTerminalSessionId: setup.terminalSessionId,
    }),
    perEntry: perEntryOk(
      intent.workspacePath,
      created.worktreePath,
      created.branch,
    ),
  };
}
