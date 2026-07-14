import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { CicShellConfigSetInput } from "@cic/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Updates the stored shell config. Either field may be `null` to preserve
 * the existing stored value (or fall back to the synthesised default). On
 * success, invalidates `cicShellConfig` so the form reflects the
 * new value; the new host process picks it up on its next start.
 */
export function useRunnerCicShellConfigSetMutation(): UseMutationResult<
  void,
  Error,
  CicShellConfigSetInput
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const cicCli = runnerHost.cicCli;
  return useMutation<void, Error, CicShellConfigSetInput>({
    mutationKey: runnerMutationKeys.cicShellConfigSet(),
    mutationFn: (input) => {
      if (cicCli === null) {
        return Promise.reject(
          new Error("cicCli unavailable on this runner host"),
        );
      }
      return cicCli.shellConfigSet(input);
    },
    onSuccess: () => {
      if (cicCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.cicShellConfig(cicCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to update shell config");
    },
  });
}
