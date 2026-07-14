import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

interface SetEnvOverrideInput {
  readonly key: string;
  readonly value: string | null;
}

/**
 * Inserts or updates a single env override. The host picks up the new
 * value on its next bootstrap (the CLI's `host start` reads the table
 * before exec'ing the bundle).
 */
export function useRunnerCicEnvOverrideSetMutation(): UseMutationResult<
  void,
  Error,
  SetEnvOverrideInput
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const cicCli = runnerHost.cicCli;
  return useMutation<void, Error, SetEnvOverrideInput>({
    mutationKey: runnerMutationKeys.cicEnvOverrideSet(),
    mutationFn: (input) => {
      if (cicCli === null) {
        return Promise.reject(
          new Error("cicCli unavailable on this runner host"),
        );
      }
      return cicCli.envOverrideSet(input);
    },
    onSuccess: () => {
      if (cicCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.cicEnvOverrideList(cicCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to save env override");
    },
  });
}
