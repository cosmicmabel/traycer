import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Drops the stored shell row entirely; the next read synthesises defaults.
 * Useful when a user has wedged themselves into a non-functional shell and
 * wants to fall back to the OS default.
 */
export function useRunnerCicShellConfigResetMutation(): UseMutationResult<
  void,
  Error,
  void
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const cicCli = runnerHost.cicCli;
  return useMutation<void>({
    mutationKey: runnerMutationKeys.cicShellConfigReset(),
    mutationFn: () => {
      if (cicCli === null) {
        return Promise.reject(
          new Error("cicCli unavailable on this runner host"),
        );
      }
      return cicCli.shellConfigReset();
    },
    onSuccess: () => {
      if (cicCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.cicShellConfig(cicCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to reset shell config");
    },
  });
}
