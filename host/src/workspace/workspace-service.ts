import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  PreparedWorkspaceFolder,
  PrepareWorkspaceFoldersResponse,
  TaskRepoIdentifier,
} from "@cic/protocol/host/epic/unary-schemas";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceFileMentionSuggestion,
  WorkspaceFileTreeGitStatus,
  WorkspaceFileTreeGitStatusEntry,
  WorkspaceFileTreeNode,
  WorkspaceFolderMentionSuggestion,
  WorkspaceGitBranchMentionSuggestion,
  WorkspaceGitCommitMentionSuggestion,
  WorkspaceGitRootMentionSuggestion,
  WorkspaceListDirectoryResponse,
  WorkspaceListFileTreeResponse,
  WorkspaceReadFileResponse,
  WorkspaceWorktreeMentionSuggestion,
} from "@cic/protocol/host/workspace/unary-schemas";
import { runGit as runGitExpectingExitCodes } from "../git/git-exec";

/**
 * Local filesystem + git backing for the `workspace.*` unary surface.
 *
 * The closed host runs these against its own workspace bookkeeping; the open
 * host answers them directly from disk and from `git` subprocesses (mentions,
 * file trees, folder preparation for epic creation). Every path sent to a
 * client is host-canonical per the wire contract: POSIX-relative to the
 * workspace root, `/`-separated, no leading slash.
 *
 * All entry points treat unreadable paths and non-git folders as soft
 * failures (empty lists / null identifiers), because the renderer calls them
 * speculatively while the user types.
 */

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  return runGitExpectingExitCodes(cwd, args, [0]);
}

/**
 * Parses `owner/repo` out of the common git remote URL forms:
 * `git@host:owner/repo.git`, `ssh://git@host/owner/repo.git`,
 * `https://host/owner/repo(.git)`. Deep paths (GitLab subgroups) use the
 * last two segments, matching the cloud's repo-identifier granularity.
 */
export function parseRepoIdentifierFromRemoteUrl(
  url: string,
): TaskRepoIdentifier | null {
  const scpMatch = /^[\w.-]+@[\w.-]+:(.+)$/.exec(url);
  const path =
    scpMatch !== null
      ? scpMatch[1]
      : /^(?:https?|ssh|git):\/\//.test(url)
        ? url.replace(/^(?:https?|ssh|git):\/\/[^/]+\//, "")
        : null;
  if (path === null) {
    return null;
  }
  const segments = path
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const owner = segments[segments.length - 2];
  const repo = segments[segments.length - 1];
  return { owner, repo };
}

export async function prepareWorkspaceFolders(
  folderPaths: readonly string[],
): Promise<PrepareWorkspaceFoldersResponse> {
  const folders: PreparedWorkspaceFolder[] = [];
  for (const folderPath of folderPaths) {
    const workspacePath = resolve(folderPath);
    const info = await stat(workspacePath).catch(() => null);
    if (info === null || !info.isDirectory()) {
      continue;
    }
    const remoteUrl = await runGit(workspacePath, [
      "remote",
      "get-url",
      "origin",
    ]);
    folders.push({
      workspacePath,
      workspaceName: basename(workspacePath),
      repoIdentifier:
        remoteUrl === null ? null : parseRepoIdentifierFromRemoteUrl(remoteUrl),
      repoUrl: remoteUrl,
    });
  }
  const seen = new Set<string>();
  const repoIdentifiers = folders
    .map((folder) => folder.repoIdentifier)
    .filter((identifier): identifier is TaskRepoIdentifier => {
      if (identifier === null) {
        return false;
      }
      const key = `${identifier.owner}/${identifier.repo}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  return { folders, repoIdentifiers };
}

// ─── File listing ───────────────────────────────────────────────────────────

const WALK_SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

/**
 * Workspace-relative POSIX file paths. Git repos use `git ls-files` so the
 * ignore rules match the user's own; non-git folders fall back to a bounded
 * filesystem walk that skips `.git`/`node_modules`.
 */
async function listWorkspaceFiles(
  workspacePath: string,
  maxFiles: number,
  includeIgnored: boolean,
): Promise<{ readonly files: string[]; readonly truncated: boolean }> {
  const tracked = await runGit(workspacePath, [
    "ls-files",
    "--cached",
    "--others",
    ...(includeIgnored ? [] : ["--exclude-standard"]),
  ]);
  if (tracked !== null) {
    const files = tracked.split("\n").filter((line) => line.length > 0);
    return {
      files: files.slice(0, maxFiles),
      truncated: files.length > maxFiles,
    };
  }
  const files: string[] = [];
  let truncated = false;
  const pending: string[] = [""];
  while (pending.length > 0 && !truncated) {
    const relDir = pending.shift();
    if (relDir === undefined) {
      break;
    }
    const entries = await readdir(join(workspacePath, relDir), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRECTORIES.has(entry.name)) {
          pending.push(relPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push(relPath);
    }
  }
  return { files, truncated };
}

function porcelainStatus(code: string): WorkspaceFileTreeGitStatus | null {
  if (code.includes("R")) return "renamed";
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("M") || code.includes("T") || code.includes("U")) {
    return "modified";
  }
  return null;
}

async function workspaceGitStatus(
  workspacePath: string,
  includeIgnored: boolean,
): Promise<WorkspaceFileTreeGitStatusEntry[]> {
  const porcelain = await runGit(workspacePath, [
    "status",
    "--porcelain",
    ...(includeIgnored ? ["--ignored"] : []),
  ]);
  if (porcelain === null) {
    return [];
  }
  return porcelain
    .split("\n")
    .filter((line) => line.length > 3)
    .flatMap((line) => {
      const status = porcelainStatus(line.slice(0, 2));
      if (status === null) {
        return [];
      }
      // Rename lines are `R  old -> new`; report the new path.
      const rawPath = line.slice(3);
      const arrow = rawPath.indexOf(" -> ");
      const path = arrow === -1 ? rawPath : rawPath.slice(arrow + 4);
      return [{ path: unquoteGitPath(path), status }];
    });
}

/** Git quotes paths with special characters (`"a b.txt"`); strip one layer. */
function unquoteGitPath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return path;
}

export async function listFileTree(request: {
  readonly workspacePath: string;
  readonly maxFiles: number;
  readonly includeIgnored: boolean;
}): Promise<WorkspaceListFileTreeResponse> {
  const { files, truncated } = await listWorkspaceFiles(
    request.workspacePath,
    request.maxFiles,
    request.includeIgnored,
  );
  const nodes: WorkspaceFileTreeNode[] = files.map((path) => ({
    path,
    name: basename(path),
  }));
  return {
    workspacePath: request.workspacePath,
    files: nodes,
    gitStatus: await workspaceGitStatus(
      request.workspacePath,
      request.includeIgnored,
    ),
    truncated,
  };
}

/** Resolves a client-sent relative path, rejecting escapes from the root. */
function resolveInside(workspacePath: string, relPath: string): string | null {
  const root = resolve(workspacePath);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    return null;
  }
  return target;
}

export async function listDirectory(request: {
  readonly workspacePath: string;
  readonly directoryPath: string;
}): Promise<WorkspaceListDirectoryResponse> {
  const target = resolveInside(request.workspacePath, request.directoryPath);
  const dirents =
    target === null
      ? []
      : await readdir(target, { withFileTypes: true }).catch(() => []);
  const relDir = request.directoryPath.replace(/^\/+|\/+$/g, "");
  const entries: WorkspaceDirectoryEntry[] = dirents.map((entry) => ({
    path: relDir === "" ? entry.name : `${relDir}/${entry.name}`,
    name: entry.name,
    kind: entry.isDirectory()
      ? ("directory" as const)
      : entry.isFile()
        ? ("file" as const)
        : entry.isSymbolicLink()
          ? ("symlink" as const)
          : ("other" as const),
  }));
  return {
    workspacePath: request.workspacePath,
    directoryPath: request.directoryPath,
    entries,
  };
}

export async function readWorkspaceFile(request: {
  readonly workspacePath: string;
  readonly filePath: string;
  readonly maxBytes: number;
}): Promise<WorkspaceReadFileResponse> {
  const base = {
    workspacePath: request.workspacePath,
    filePath: request.filePath,
  };
  const target = resolveInside(request.workspacePath, request.filePath);
  if (target === null) {
    return {
      ...base,
      content: null,
      truncated: false,
      error: "path escapes the workspace root",
    };
  }
  try {
    const bytes = await readFile(target);
    const truncated = bytes.byteLength > request.maxBytes;
    const content = new TextDecoder().decode(
      truncated ? bytes.subarray(0, request.maxBytes) : bytes,
    );
    return { ...base, content, truncated, error: null };
  } catch (error) {
    return {
      ...base,
      content: null,
      truncated: false,
      error: error instanceof Error ? error.message : "read failed",
    };
  }
}

// ─── Mention suggestions ────────────────────────────────────────────────────

const MENTION_SCAN_MAX_FILES = 20_000;

function matchesQuery(candidate: string, query: string): boolean {
  return (
    query.length === 0 || candidate.toLowerCase().includes(query.toLowerCase())
  );
}

export async function mentionFiles(request: {
  readonly roots: readonly string[];
  readonly query: string;
  readonly limit: number;
}): Promise<{ entries: WorkspaceFileMentionSuggestion[] }> {
  const entries: WorkspaceFileMentionSuggestion[] = [];
  for (const root of request.roots) {
    if (entries.length >= request.limit) {
      break;
    }
    const { files } = await listWorkspaceFiles(
      root,
      MENTION_SCAN_MAX_FILES,
      false,
    );
    for (const relPath of files) {
      if (entries.length >= request.limit) {
        break;
      }
      if (!matchesQuery(relPath, request.query)) {
        continue;
      }
      const absolutePath = join(root, relPath);
      entries.push({
        kind: "file",
        id: `file:${absolutePath}`,
        label: basename(relPath),
        relPath,
        absolutePath,
        workspacePath: root,
        description:
          dirname(relPath) === "." ? basename(root) : dirname(relPath),
      });
    }
  }
  return { entries };
}

export async function mentionFolders(request: {
  readonly roots: readonly string[];
  readonly query: string;
  readonly limit: number;
}): Promise<{ entries: WorkspaceFolderMentionSuggestion[] }> {
  const entries: WorkspaceFolderMentionSuggestion[] = [];
  for (const root of request.roots) {
    if (entries.length >= request.limit) {
      break;
    }
    const { files } = await listWorkspaceFiles(
      root,
      MENTION_SCAN_MAX_FILES,
      false,
    );
    const folders = new Set<string>();
    for (const relPath of files) {
      let dir = dirname(relPath);
      while (dir !== "." && dir !== "/" && !folders.has(dir)) {
        folders.add(dir);
        dir = dirname(dir);
      }
    }
    for (const relPath of [...folders].sort()) {
      if (entries.length >= request.limit) {
        break;
      }
      if (!matchesQuery(relPath, request.query)) {
        continue;
      }
      const absolutePath = join(root, relPath);
      entries.push({
        kind: "folder",
        id: `folder:${absolutePath}`,
        label: basename(relPath),
        relPath,
        absolutePath,
        workspacePath: root,
        description:
          dirname(relPath) === "." ? basename(root) : dirname(relPath),
      });
    }
  }
  return { entries };
}

export async function mentionWorktrees(request: {
  readonly roots: readonly string[];
  readonly query: string;
  readonly limit: number;
}): Promise<{ entries: WorkspaceWorktreeMentionSuggestion[] }> {
  const entries: WorkspaceWorktreeMentionSuggestion[] = [];
  for (const root of request.roots) {
    const porcelain = await runGit(root, ["worktree", "list", "--porcelain"]);
    if (porcelain === null) {
      continue;
    }
    let index = 0;
    for (const block of porcelain.split("\n\n")) {
      if (entries.length >= request.limit) {
        break;
      }
      const lines = block.split("\n");
      const pathLine = lines.find((line) => line.startsWith("worktree "));
      if (pathLine === undefined) {
        continue;
      }
      const worktreePath = pathLine.slice("worktree ".length);
      const branchLine = lines.find((line) => line.startsWith("branch "));
      const branch =
        branchLine === undefined
          ? null
          : branchLine.slice("branch ".length).replace(/^refs\/heads\//, "");
      const label = basename(worktreePath);
      const isMain = index === 0;
      index += 1;
      if (
        !matchesQuery(label, request.query) &&
        !matchesQuery(branch ?? "", request.query)
      ) {
        continue;
      }
      entries.push({
        kind: "worktree",
        id: `worktree:${worktreePath}`,
        label,
        worktreePath,
        workspacePath: root,
        branch,
        isMain,
        description:
          branch === null ? "detached" : isMain ? `${branch} (main)` : branch,
      });
    }
  }
  return { entries };
}

export async function mentionGitRoot(request: {
  readonly workspacePath: string;
  readonly query: string;
  readonly limit: number;
}): Promise<{ entries: WorkspaceGitRootMentionSuggestion[] }> {
  const inRepo = await runGit(request.workspacePath, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (inRepo !== "true") {
    return { entries: [] };
  }
  const entries: WorkspaceGitRootMentionSuggestion[] = [];
  if (matchesQuery("uncommitted changes", request.query)) {
    entries.push({
      kind: "git",
      id: `git:uncommitted:${request.workspacePath}`,
      label: "Uncommitted changes",
      description: "Diff against the working tree",
      workspacePath: request.workspacePath,
      gitType: "against_uncommitted_changes",
      branchName: null,
      commitHash: null,
    });
  }
  const currentBranch = await runGit(request.workspacePath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (
    currentBranch !== null &&
    currentBranch !== "HEAD" &&
    matchesQuery(currentBranch, request.query)
  ) {
    entries.push({
      kind: "git",
      id: `git:branch:${request.workspacePath}:${currentBranch}`,
      label: currentBranch,
      description: "Current branch",
      workspacePath: request.workspacePath,
      gitType: "against_branch",
      branchName: currentBranch,
      commitHash: null,
    });
  }
  return { entries: entries.slice(0, request.limit) };
}

export async function mentionGitBranches(request: {
  readonly workspacePath: string;
  readonly query: string;
  readonly limit: number;
}): Promise<{ entries: WorkspaceGitBranchMentionSuggestion[] }> {
  const output = await runGit(request.workspacePath, [
    "for-each-ref",
    "refs/heads",
    "--sort=-committerdate",
    "--format=%(refname:short)",
  ]);
  if (output === null) {
    return { entries: [] };
  }
  const entries = output
    .split("\n")
    .filter(
      (branch) => branch.length > 0 && matchesQuery(branch, request.query),
    )
    .slice(0, request.limit)
    .map((branch) => ({
      kind: "git" as const,
      id: `git:branch:${request.workspacePath}:${branch}`,
      label: branch,
      description: "Branch",
      workspacePath: request.workspacePath,
      gitType: "against_branch" as const,
      branchName: branch,
      commitHash: null,
    }));
  return { entries };
}

export async function mentionGitCommits(request: {
  readonly workspacePath: string;
  readonly query: string;
  readonly limit: number;
}): Promise<{ entries: WorkspaceGitCommitMentionSuggestion[] }> {
  const output = await runGit(request.workspacePath, [
    "log",
    "-n",
    "200",
    "--format=%H%x09%s",
  ]);
  if (output === null) {
    return { entries: [] };
  }
  const entries = output
    .split("\n")
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) {
        return [];
      }
      const hash = line.slice(0, tab);
      const subject = line.slice(tab + 1);
      if (
        !matchesQuery(subject, request.query) &&
        !hash.startsWith(request.query.toLowerCase())
      ) {
        return [];
      }
      return [
        {
          kind: "git" as const,
          id: `git:commit:${request.workspacePath}:${hash}`,
          label: subject,
          description: hash.slice(0, 12),
          workspacePath: request.workspacePath,
          gitType: "against_commit" as const,
          branchName: null,
          commitHash: hash,
        },
      ];
    })
    .slice(0, request.limit);
  return { entries };
}
