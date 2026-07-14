import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

interface DeleteEnvOverrideInput {
  readonly key: string;
}

/**
 * Removes a single env override row. The next host bootstrap will no
 * longer set that variable (and so the user's shell-resolved value, if
 * any, takes effect again).
 */
export function useRunnerCicEnvOverrideDeleteMutation(): UseMutationResult<
  void,
  Error,
  DeleteEnvOverrideInput
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const cicCli = runnerHost.cicCli;
  return useMutation<void, Error, DeleteEnvOverrideInput>({
    mutationKey: runnerMutationKeys.cicEnvOverrideDelete(),
    mutationFn: (input) => {
      if (cicCli === null) {
        return Promise.reject(
          new Error("cicCli unavailable on this runner host"),
        );
      }
      return cicCli.envOverrideDelete(input);
    },
    onSuccess: () => {
      if (cicCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.cicEnvOverrideList(cicCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to delete env override");
    },
  });
}
