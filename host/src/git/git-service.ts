import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  GitChangedFileV10,
  GitFileStatus,
  GitGetCapabilitiesResponse,
  GitGetFileDiffResponse,
  GitStage,
  RepoState,
} from "@traycer/protocol/host/git-schemas";
import { runGit } from "./git-exec";

/**
 * Local-git backing for the `git.*` unary surface and the
 * `git.subscribeStatus` poller (see git-status-broadcaster.ts).
 *
 * All commands run against `runningDir` (a canonical absolute host path per
 * the wire contract) with plain `git` subprocesses. File rows follow the
 * frozen `gitChangedFileV10Schema` two-axis model: `status` is what changed,
 * `stage` is where (staged/unstaged/untracked/conflicted) - one worktree
 * file can therefore produce two rows. Blob OIDs are reported when porcelain
 * v2 provides them (index side); worktree OIDs stay null, which the contract
 * allows (nullable per ADR-0007 degraded mode).
 */

const OK = [0];

export async function getGitCapabilities(
  runningDir: string,
): Promise<GitGetCapabilitiesResponse> {
  const dirInfo = await stat(runningDir).catch(() => null);
  if (dirInfo === null || !dirInfo.isDirectory()) {
    return {
      available: false,
      gitVersion: null,
      reason: "running directory does not exist on this host",
    };
  }
  const versionOutput = await runGit(runningDir, ["--version"], OK);
  const gitVersion =
    versionOutput === null
      ? null
      : versionOutput.replace(/^git version\s+/, "");
  if (gitVersion === null) {
    return {
      available: false,
      gitVersion: null,
      reason: "git is not installed on this host",
    };
  }
  const inWorkTree = await runGit(
    runningDir,
    ["rev-parse", "--is-inside-work-tree"],
    OK,
  );
  if (inWorkTree !== "true") {
    return {
      available: false,
      gitVersion,
      reason: "running directory is not inside a git work tree",
    };
  }
  return { available: true, gitVersion, reason: null };
}

// ─── Status snapshot (listChangedFiles + subscribeStatus) ──────────────────

export interface GitStatusSnapshot {
  readonly runningDir: string;
  readonly headSha: string;
  readonly branch: string | null;
  readonly files: GitChangedFileV10[];
  readonly fingerprint: string;
  readonly repoMode: "normal";
  readonly repoState: RepoState;
}

const ZERO_OID = /^0+$/;

function statusFromCode(code: string): GitFileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "C":
      return "copied";
    default:
      // M (modified) and T (type change) both render as modified; R is
      // stripped before this is called (rename rows are built explicitly).
      return "modified";
  }
}

interface NumstatRow {
  readonly insertions: number;
  readonly deletions: number;
  readonly isBinary: boolean;
}

/**
 * `git diff --numstat -z` parser. Regular rows are one NUL token
 * `ins\tdel\tpath`; rename/copy rows leave the path slot empty and append the
 * two paths as their own NUL tokens (`ins\tdel\t`, `old`, `new`) - the row is
 * keyed by the NEW path to match porcelain rows. Binary rows report `-\t-`.
 */
function parseNumstat(output: string): Map<string, NumstatRow> {
  const rows = new Map<string, NumstatRow>();
  const tokens = output.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (token.length === 0) {
      continue;
    }
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
    if (match === null) {
      continue;
    }
    const isBinary = match[1] === "-";
    let path = match[3];
    if (path.length === 0) {
      // Rename/copy: skip the old path token, key by the new path token.
      index += 1;
      path = tokens[index] ?? "";
      index += 1;
    }
    if (path.length === 0) {
      continue;
    }
    rows.set(path, {
      insertions: isBinary ? 0 : Number(match[1]),
      deletions: isBinary ? 0 : Number(match[2]),
      isBinary,
    });
  }
  return rows;
}

async function fileSizeBytes(
  runningDir: string,
  path: string,
): Promise<number> {
  const info = await stat(join(runningDir, path)).catch(() => null);
  return info !== null && info.isFile() ? info.size : 0;
}

async function readGitStateFile(
  gitDir: string,
  name: string,
): Promise<string | null> {
  try {
    const raw = await readFile(join(gitDir, name), "utf8");
    const value = raw.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function detectRepoState(
  runningDir: string,
  branch: string | null,
): Promise<RepoState> {
  const gitDir = await runGit(
    runningDir,
    ["rev-parse", "--absolute-git-dir"],
    OK,
  );
  if (gitDir === null) {
    return { kind: "clean" };
  }
  const mergeHead = await readGitStateFile(gitDir, "MERGE_HEAD");
  if (mergeHead !== null) {
    return {
      kind: "merge",
      headRef: branch ?? "HEAD",
      mergeHeads: mergeHead.split("\n"),
    };
  }
  const rebaseMergeOnto = await readGitStateFile(gitDir, "rebase-merge/onto");
  if (rebaseMergeOnto !== null) {
    const headName = await readGitStateFile(gitDir, "rebase-merge/head-name");
    const step = await readGitStateFile(gitDir, "rebase-merge/msgnum");
    const total = await readGitStateFile(gitDir, "rebase-merge/end");
    return {
      kind: "rebase",
      ontoSha: rebaseMergeOnto,
      originalBranch: headName?.replace(/^refs\/heads\//, "") ?? null,
      step: step === null ? null : Number(step),
      totalSteps: total === null ? null : Number(total),
    };
  }
  const rebaseApplyNext = await readGitStateFile(gitDir, "rebase-apply/next");
  if (rebaseApplyNext !== null) {
    const applying = await readGitStateFile(gitDir, "rebase-apply/applying");
    if (applying !== null) {
      const patchName = await readGitStateFile(gitDir, "rebase-apply/msg");
      return { kind: "am", patchName };
    }
    const onto = await readGitStateFile(gitDir, "rebase-apply/onto");
    const headName = await readGitStateFile(gitDir, "rebase-apply/head-name");
    const total = await readGitStateFile(gitDir, "rebase-apply/last");
    return {
      kind: "rebase",
      ontoSha: onto ?? "",
      originalBranch: headName?.replace(/^refs\/heads\//, "") ?? null,
      step: Number(rebaseApplyNext),
      totalSteps: total === null ? null : Number(total),
    };
  }
  const cherryPick = await readGitStateFile(gitDir, "CHERRY_PICK_HEAD");
  if (cherryPick !== null) {
    return { kind: "cherry-pick", pickingSha: cherryPick };
  }
  const revert = await readGitStateFile(gitDir, "REVERT_HEAD");
  if (revert !== null) {
    return { kind: "revert", revertingSha: revert };
  }
  const bisect = await readGitStateFile(gitDir, "BISECT_LOG");
  if (bisect !== null) {
    return { kind: "bisect", goodSha: null, badSha: null };
  }
  return { kind: "clean" };
}

export async function gitStatusSnapshot(
  requestedRunningDir: string,
): Promise<GitStatusSnapshot> {
  const runningDir = resolve(requestedRunningDir);
  const headSha = (await runGit(runningDir, ["rev-parse", "HEAD"], OK)) ?? "";
  const branchName = await runGit(
    runningDir,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    OK,
  );
  const branch =
    branchName === null || branchName === "HEAD" ? null : branchName;

  const [porcelain, stagedNumstatRaw, unstagedNumstatRaw] = await Promise.all([
    runGit(
      runningDir,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      OK,
    ),
    runGit(runningDir, ["diff", "--cached", "--numstat", "-z", "-M"], OK),
    runGit(runningDir, ["diff", "--numstat", "-z"], OK),
  ]);
  const stagedNumstat = parseNumstat(stagedNumstatRaw ?? "");
  const unstagedNumstat = parseNumstat(unstagedNumstatRaw ?? "");

  const files: GitChangedFileV10[] = [];
  const pushRow = async (input: {
    readonly path: string;
    readonly previousPath: string | null;
    readonly status: GitFileStatus;
    readonly stage: GitStage;
    readonly stagedOid: string | null;
    readonly numstat: NumstatRow | undefined;
  }): Promise<void> => {
    files.push({
      path: input.path,
      previousPath: input.previousPath,
      status: input.status,
      stage: input.stage,
      isBinary: input.numstat?.isBinary ?? false,
      insertions: input.numstat?.insertions ?? 0,
      deletions: input.numstat?.deletions ?? 0,
      sizeBytes: await fileSizeBytes(runningDir, input.path),
      stagedOid: input.stagedOid,
      worktreeOid: null,
    });
  };

  const tokens = (porcelain ?? "").split("\0");
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (token.length === 0) {
      continue;
    }
    const type = token[0];
    if (type === "?") {
      const path = token.slice(2);
      await pushRow({
        path,
        previousPath: null,
        status: "untracked",
        stage: "untracked",
        stagedOid: null,
        numstat: undefined,
      });
      continue;
    }
    if (type === "u") {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = token.split(" ");
      const path = fields.slice(10).join(" ");
      await pushRow({
        path,
        previousPath: null,
        status: "conflicted",
        stage: "conflicted",
        stagedOid: null,
        numstat: unstagedNumstat.get(path),
      });
      continue;
    }
    if (type !== "1" && type !== "2") {
      continue;
    }
    // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path> NUL <origPath>
    const fields = token.split(" ");
    const xy = fields[1] ?? "..";
    const indexOid = fields[7] ?? "";
    const stagedOid =
      indexOid.length > 0 && !ZERO_OID.test(indexOid) ? indexOid : null;
    const pathFieldStart = type === "1" ? 8 : 9;
    const path = fields.slice(pathFieldStart).join(" ");
    let previousPath: string | null = null;
    if (type === "2") {
      previousPath = tokens[index] ?? null;
      index += 1;
    }
    const stagedCode = xy[0];
    const unstagedCode = xy[1];
    if (stagedCode !== ".") {
      await pushRow({
        path,
        previousPath,
        status: stagedCode === "R" ? "renamed" : statusFromCode(stagedCode),
        stage: "staged",
        stagedOid,
        numstat: stagedNumstat.get(path),
      });
    }
    if (unstagedCode !== ".") {
      await pushRow({
        path,
        previousPath: unstagedCode === "R" ? previousPath : null,
        status: unstagedCode === "R" ? "renamed" : statusFromCode(unstagedCode),
        stage: "unstaged",
        stagedOid,
        numstat: unstagedNumstat.get(path),
      });
    }
  }

  const repoState = await detectRepoState(runningDir, branch);
  const fingerprint = createHash("sha1")
    .update(headSha)
    .update(JSON.stringify(files))
    .update(JSON.stringify(repoState))
    .digest("hex");

  return {
    runningDir,
    headSha,
    branch,
    files,
    fingerprint,
    repoMode: "normal",
    repoState,
  };
}

// ─── File diffs ─────────────────────────────────────────────────────────────

/**
 * One stage-scoped patch. `byteBudget: null` means untruncated. Failures
 * (bad path, no repo) degrade to an empty patch rather than an RPC error -
 * the diff pane renders "no changes" and the status list stays live.
 */
export async function getFileDiff(request: {
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly stage: GitStage;
  readonly ignoreWhitespace: boolean;
  readonly byteBudget: number | null;
}): Promise<GitGetFileDiffResponse> {
  const runningDir = resolve(request.runningDir);
  const headSha = (await runGit(runningDir, ["rev-parse", "HEAD"], OK)) ?? "";
  const whitespace = request.ignoreWhitespace ? ["-w"] : [];
  let patch: string;
  if (request.stage === "untracked") {
    // `--no-index` exits 1 when the files differ; that IS the success path.
    patch =
      (await runGit(
        runningDir,
        [
          "diff",
          "--no-index",
          ...whitespace,
          "--",
          "/dev/null",
          join(runningDir, request.filePath),
        ],
        [0, 1],
      )) ?? "";
  } else {
    const scope = request.stage === "staged" ? ["--cached", "-M"] : [];
    const paths =
      request.previousPath === null
        ? [request.filePath]
        : [request.previousPath, request.filePath];
    patch =
      (await runGit(
        runningDir,
        ["diff", ...scope, ...whitespace, "--", ...paths],
        OK,
      )) ?? "";
  }
  const isBinary = /^Binary files .* differ$/m.test(patch);
  const bytes = new TextEncoder().encode(patch);
  const isTruncated =
    request.byteBudget !== null && bytes.byteLength > request.byteBudget;
  const kept = isTruncated
    ? new TextDecoder().decode(bytes.subarray(0, request.byteBudget ?? 0))
    : patch;
  return {
    filePath: request.filePath,
    headSha,
    stagedOid: null,
    worktreeOid: null,
    patch: kept,
    isTruncated,
    truncatedAfterBytes: isTruncated ? request.byteBudget : null,
    isBinary,
  };
}

/** Batch variant: files share one byte budget, consumed in request order. */
export async function getFileDiffs(request: {
  readonly runningDir: string;
  readonly files: ReadonlyArray<{
    readonly filePath: string;
    readonly previousPath: string | null;
    readonly stage: GitStage;
  }>;
  readonly ignoreWhitespace: boolean;
  readonly byteBudget: number;
}): Promise<{
  runningDir: string;
  headSha: string;
  diffs: GitGetFileDiffResponse[];
}> {
  const runningDir = resolve(request.runningDir);
  const headSha = (await runGit(runningDir, ["rev-parse", "HEAD"], OK)) ?? "";
  let remaining = request.byteBudget;
  const diffs: GitGetFileDiffResponse[] = [];
  for (const file of request.files) {
    if (remaining <= 0) {
      diffs.push({
        filePath: file.filePath,
        headSha,
        stagedOid: null,
        worktreeOid: null,
        patch: "",
        isTruncated: true,
        truncatedAfterBytes: 0,
        isBinary: false,
      });
      continue;
    }
    const diff = await getFileDiff({
      runningDir,
      filePath: file.filePath,
      previousPath: file.previousPath,
      stage: file.stage,
      ignoreWhitespace: request.ignoreWhitespace,
      byteBudget: remaining,
    });
    remaining -= new TextEncoder().encode(diff.patch).byteLength;
    diffs.push(diff);
  }
  return { runningDir, headSha, diffs };
}
