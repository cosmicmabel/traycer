/**
 * Shared `git` subprocess runner for the workspace and git surfaces.
 *
 * Returns stdout (trailing newline stripped) when the exit code is in
 * `okExitCodes`, otherwise null. Callers list the codes explicitly because
 * some git commands report data through nonzero exits (`git diff --no-index`
 * exits 1 when the files differ).
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  okExitCodes: readonly number[],
): Promise<string | null> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const output = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    return okExitCodes.includes(exitCode) ? output.replace(/\n$/, "") : null;
  } catch {
    return null;
  }
}
