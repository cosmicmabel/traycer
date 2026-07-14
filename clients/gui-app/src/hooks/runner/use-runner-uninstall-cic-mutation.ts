import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { CicUninstallResult } from "@cic/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * In-app "Remove CIC" (Settings → General → Danger Zone). Stops + removes
 * the host service, host install, and (on macOS) the SMAppService login item,
 * and marks the device removed-by-user so the host is not auto-reinstalled
 * when it goes unreachable. All `~/.cic` user data is preserved.
 *
 * Returns the raw mutation result so the Danger Zone can drive `isPending`
 * and switch to its success/quit state from `isSuccess`.
 */
export function useRunnerUninstallCic(): UseMutationResult<
  CicUninstallResult,
  Error,
  void
> {
  const { hostManagement } = useRunnerHost();
  return useMutation<CicUninstallResult>({
    mutationKey: runnerMutationKeys.uninstallCic(),
    mutationFn: () => {
      if (hostManagement === null) {
        return Promise.reject(
          new Error("Removing CIC is not available on this platform."),
        );
      }
      return hostManagement.uninstallCic();
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't remove CIC's components."),
  });
}
