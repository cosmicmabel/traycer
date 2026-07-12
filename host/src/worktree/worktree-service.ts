import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  workspaceScriptsSchema,
  type WorkspaceScripts,
  type WorktreeBranch,
  type WorktreeListBranchesResponse,
  type WorktreeListByWorkspacePathsRequestV11,
  type WorktreeListByWorkspacePathsResponseV11,
  type WorktreeScriptsAtRef,
  type WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import { runGit } from "../git/git-exec";
import { hostHomeDir } from "../pid-file";
import { parseRepoIdentifierFromRemoteUrl } from "../workspace/workspace-service";

/**
 * Read-only slice of the `worktree.*` surface: branch listings and the
 * pre-Epic disk-truth workspace summaries the Create-worktree modal reads.
 * Worktree CREATION (bindings, setup scripts, carry-stash) is not
 * implemented yet — the open host answers the read methods so pickers
 * populate, and the mutating methods still return structured RPC errors.
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
      ? await readFile(join(workspacePath, ".traycer", "environment.json"), {
          encoding: "utf8",
        }).catch(() => null)
      : await runGit(
          workspacePath,
          ["show", `${ref}:.traycer/environment.json`],
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
