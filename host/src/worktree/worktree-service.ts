import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  workspaceScriptsSchema,
  type WorkspaceScripts,
  type WorktreeBindingSelectorRow,
  type WorktreeBranch,
  type WorktreeHostEntryV11,
  type WorktreeListBranchesResponse,
  type WorktreeListByWorkspacePathsRequestV11,
  type WorktreeListByWorkspacePathsResponseV11,
  type WorktreeScriptsAtRef,
  type WorktreeWorkspaceSummary,
} from "@cic/protocol/host/worktree-schemas";
import { runGit } from "../git/git-exec";
import { hostHomeDir } from "../pid-file";
import { parseRepoIdentifierFromRemoteUrl } from "../workspace/workspace-service";
import type { BindingRow, BindingStore } from "./binding-store";
import { worktreesRoot } from "./worktree-mutations";

/**
 * Read side of the `worktree.*` surface: branch listings, the pre-Epic
 * disk-truth workspace summaries the Create-worktree modal reads, the
 * binding selector rows, and the host-wide worktree listing. The mutating
 * half (create/import/delete, setup runs) lives in worktree-mutations.ts.
 */
const OK = [0];

export async function listBranches(request: {
  readonly workspacePath: string;
  readonly includeRemote: boolean;
}): Promise<WorktreeListBranchesResponse> {
  const current = await runGit(
    request.workspacePath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    OK,
  );
  const locals =
    (await runGit(
      request.workspacePath,
      [
        "for-each-ref",
        "refs/heads",
        "--sort=-committerdate",
        "--format=%(refname:short)",
      ],
      OK,
    )) ?? "";
  const localNames = locals.split("\n").filter((name) => name.length > 0);
  const branches: WorktreeBranch[] = localNames.map((name) => ({
    name,
    isCurrent: name === current,
    isRemoteOnly: false,
  }));
  if (request.includeRemote) {
    const remotes =
      (await runGit(
        request.workspacePath,
        ["for-each-ref", "refs/remotes", "--format=%(refname:short)"],
        OK,
      )) ?? "";
    const known = new Set(localNames);
    for (const remoteName of remotes.split("\n")) {
      const name = remoteName.replace(/^[^/]+\//, "");
      if (
        remoteName.length === 0 ||
        remoteName.endsWith("/HEAD") ||
        name.length === 0 ||
        known.has(name)
      ) {
        continue;
      }
      known.add(name);
      branches.push({ name, isCurrent: false, isRemoteOnly: true });
    }
  }
  const status =
    (await runGit(
      request.workspacePath,
      ["status", "--porcelain", "-uall"],
      OK,
    )) ?? "";
  const uncommittedFileCount = status
    .split("\n")
    .filter((line) => line.length > 3).length;
  return { branches, uncommittedFileCount };
}

async function readScriptsAt(
  workspacePath: string,
  ref: string | null,
): Promise<WorkspaceScripts | null> {
  const raw =
    ref === null
      ? await readFile(join(workspacePath, ".cic", "environment.json"), {
          encoding: "utf8",
        }).catch(() => null)
      : await runGit(
          workspacePath,
          ["show", `${ref}:.cic/environment.json`],
          OK,
        );
  if (raw === null) {
    return null;
  }
  try {
    const parsed = workspaceScriptsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function summarizeWorkspace(
  workspacePath: string,
): Promise<WorktreeWorkspaceSummary> {
  const inRepo = await runGit(
    workspacePath,
    ["rev-parse", "--is-inside-work-tree"],
    OK,
  );
  const isGitRepo = inRepo === "true";
  if (!isGitRepo) {
    return {
      workspacePath,
      isGitRepo: false,
      repoIdentifier: null,
      mainBranch: null,
      worktrees: [],
      scripts: null,
    };
  }
  const remoteUrl = await runGit(
    workspacePath,
    ["remote", "get-url", "origin"],
    OK,
  );
  const originHead = await runGit(
    workspacePath,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    OK,
  );
  const currentBranch = await runGit(
    workspacePath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    OK,
  );
  const mainBranch =
    originHead !== null
      ? originHead.replace(/^[^/]+\//, "")
      : currentBranch === "HEAD"
        ? null
        : currentBranch;
  const porcelain =
    (await runGit(workspacePath, ["worktree", "list", "--porcelain"], OK)) ??
    "";
  let isFirst = true;
  const worktrees = porcelain.split("\n\n").flatMap((block) => {
    const lines = block.split("\n");
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (pathLine === undefined) {
      return [];
    }
    const isMain = isFirst;
    isFirst = false;
    const branchLine = lines.find((line) => line.startsWith("branch "));
    const headLine = lines.find((line) => line.startsWith("HEAD "));
    return [
      {
        worktreePath: pathLine.slice("worktree ".length),
        branch:
          branchLine === undefined
            ? null
            : branchLine.slice("branch ".length).replace(/^refs\/heads\//, ""),
        sourceBranch: null,
        head: headLine === undefined ? null : headLine.slice("HEAD ".length),
        isMain,
        isLocked: lines.some((line) => line.startsWith("locked")),
      },
    ];
  });
  return {
    workspacePath,
    isGitRepo,
    repoIdentifier:
      remoteUrl === null ? null : parseRepoIdentifierFromRemoteUrl(remoteUrl),
    mainBranch,
    worktrees,
    scripts: await readScriptsAt(workspacePath, null),
  };
}

export async function listByWorkspacePaths(
  request: WorktreeListByWorkspacePathsRequestV11,
): Promise<WorktreeListByWorkspacePathsResponseV11> {
  const workspaces: WorktreeWorkspaceSummary[] = [];
  for (const workspacePath of request.workspacePaths) {
    workspaces.push(await summarizeWorkspace(workspacePath));
  }
  const scriptsAtRefs: WorktreeScriptsAtRef[] = [];
  for (const scriptRef of request.scriptRefs) {
    scriptsAtRefs.push({
      workspacePath: scriptRef.workspacePath,
      ref: scriptRef.ref,
      scripts: await readScriptsAt(scriptRef.workspacePath, scriptRef.ref),
    });
  }
  return { workspaces, scriptsAtRefs };
}

const SETUP_DISABLED_REASONS = {
  pending: "setup_pending",
  running: "setup_running",
  failed: "setup_failed",
  cancelled: "setup_cancelled",
} as const;

/**
 * `worktree.listBindingsForEpic` rows: every binding entry for the epic,
 * deduped by effective running directory with source owner refs merged, and
 * a disabled reason derived from setup state / on-disk presence.
 */
export async function listBindingSelectorRows(
  bindings: BindingStore,
  epicId: string,
): Promise<WorktreeBindingSelectorRow[]> {
  const rowsByDir = new Map<string, WorktreeBindingSelectorRow>();
  for (const row of await bindings.listForEpic(epicId)) {
    for (const entry of row.binding.entries) {
      const runningDir = entry.worktreePath ?? entry.workspacePath;
      const source = {
        ownerKind: row.ownerKind,
        ownerId: row.ownerId,
        workspacePath: entry.workspacePath,
        isPrimary: entry.isPrimary,
        mode: entry.mode,
      };
      const existing = rowsByDir.get(runningDir);
      if (existing !== undefined) {
        existing.sources.push(source);
        continue;
      }
      const onDisk = await stat(runningDir).catch(() => null);
      const inRepo = await runGit(
        runningDir,
        ["rev-parse", "--is-inside-work-tree"],
        OK,
      );
      const setupReason =
        entry.setupState === "pending" ||
        entry.setupState === "running" ||
        entry.setupState === "failed" ||
        entry.setupState === "cancelled"
          ? SETUP_DISABLED_REASONS[entry.setupState]
          : null;
      rowsByDir.set(runningDir, {
        hostId: "open-host",
        runningDir,
        workspacePath: entry.workspacePath,
        worktreePath: entry.worktreePath,
        mode: entry.mode,
        isGitRepo: inRepo === "true",
        repoIdentifier: entry.repoIdentifier,
        branch: entry.branch,
        isPrimary: entry.isPrimary,
        isImported: entry.isImported,
        setupState: entry.setupState,
        disabledReason:
          onDisk === null || !onDisk.isDirectory()
            ? "missing_worktree_path"
            : setupReason,
        sources: [source],
      });
    }
  }
  return [...rowsByDir.values()];
}

function ownersReferencing(
  rows: readonly BindingRow[],
  worktreePath: string,
): WorktreeHostEntryV11["owners"] {
  return rows.flatMap((row) =>
    row.binding.entries.some(
      (entry) => (entry.worktreePath ?? entry.workspacePath) === worktreePath,
    )
      ? [
          {
            epicId: row.epicId,
            ownerKind: row.ownerKind,
            ownerId: row.ownerId,
            updatedAt: row.updatedAt,
          },
        ]
      : [],
  );
}

/**
 * `worktree.listAllForHost@1.1`: disk-truth walk of the host worktree root
 * (`<hostHome>/open-host-worktrees/<bucket>/<name>`), cross-referenced with
 * binding rows for `inUse`/`owners`. Activity probes are best-effort and
 * only run when requested: `branchStatus.mergedIntoDefault` from local
 * ancestry, PR probing is not attempted (`prState: "none"` when probed).
 */
export async function listHostWorktrees(input: {
  readonly environment: string;
  readonly bindings: BindingStore;
  readonly includeActivity: boolean;
  readonly activityPaths: readonly string[] | null;
}): Promise<WorktreeHostEntryV11[]> {
  const root = worktreesRoot(input.environment);
  const buckets = await readdir(root, { withFileTypes: true }).catch(() => []);
  const bindingRows = await input.bindings.listAll();
  const entries: WorktreeHostEntryV11[] = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) {
      continue;
    }
    const bucketDir = join(root, bucket.name);
    const names = await readdir(bucketDir, { withFileTypes: true }).catch(
      () => [],
    );
    for (const name of names) {
      if (!name.isDirectory()) {
        continue;
      }
      const worktreePath = join(bucketDir, name.name);
      if (
        input.activityPaths !== null &&
        !input.activityPaths.includes(worktreePath)
      ) {
        continue;
      }
      const enrich = input.includeActivity || input.activityPaths !== null;
      const inRepo = await runGit(
        worktreePath,
        ["rev-parse", "--is-inside-work-tree"],
        OK,
      );
      const branch = await runGit(
        worktreePath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        OK,
      );
      const remoteUrl = await runGit(
        worktreePath,
        ["remote", "get-url", "origin"],
        OK,
      );
      const repoIdentifier =
        remoteUrl === null ? null : parseRepoIdentifierFromRemoteUrl(remoteUrl);
      const status = await runGit(
        worktreePath,
        ["status", "--porcelain", "-uall"],
        OK,
      );
      const owners = ownersReferencing(bindingRows, worktreePath);
      const dirInfo = await stat(worktreePath).catch(() => null);
      let mergedIntoDefault: boolean | null = null;
      if (enrich) {
        const originHead = await runGit(
          worktreePath,
          ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
          OK,
        );
        if (originHead !== null) {
          mergedIntoDefault =
            (await runGit(
              worktreePath,
              ["merge-base", "--is-ancestor", "HEAD", originHead],
              OK,
            )) !== null;
        }
      }
      entries.push({
        worktreePath,
        repoLabel:
          repoIdentifier === null
            ? name.name
            : `${repoIdentifier.owner}/${repoIdentifier.repo}`,
        repoIdentifier,
        branch: branch === "HEAD" ? null : branch,
        inUse: owners.length > 0,
        uncommittedCount: (status ?? "")
          .split("\n")
          .filter((line) => line.length > 3).length,
        gitRemovable: inRepo === "true",
        scripts: await readScriptsAt(worktreePath, null),
        lastActivityAt: null,
        owners,
        branchStatus:
          mergedIntoDefault === null
            ? null
            : { ahead: null, behind: null, mergedIntoDefault },
        createdAt: dirInfo === null ? null : Math.round(dirInfo.mtimeMs),
        prState: enrich ? "none" : null,
        prNumber: null,
        prUrl: null,
        mergedHeadShaMatches: false,
        submodules: [],
        atBaseCommit: false,
      });
    }
  }
  return entries;
}

/**
 * Host-owned fallback cwd for terminal launches on a folderless epic
 * (`worktree.listBindingsForEpic@1.1`'s `folderlessCwd`). Minted lazily
 * under the host home so the directory always exists when the picker
 * launches a terminal into it.
 */
export async function ensureFolderlessCwd(
  environment: string,
  epicId: string,
): Promise<string> {
  const safe = epicId.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = join(hostHomeDir(environment), "open-host-epic-cwd", safe);
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  return dir;
}
