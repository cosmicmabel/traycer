import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";

export interface CliLoginVariables {
  readonly token: string;
  readonly refreshToken: string;
}

/**
 * Seeds the CLI's stored credentials with the renderer's captured bearer so
 * the CLI keeps using it for host comms (and can refresh it on a 401). The
 * host pipes the token to `cic login --token -` over stdin. Best-effort and
 * silent on error - failure does not affect the signed-in renderer, and the CLI
 * self-refreshes as a fallback - so the local-host runtime owns no UI for it
 * (mirrors `useRunnerEnsureHost`). Resolves to a no-op on shells without a
 * local CLI (`cicCli === null`: mobile, web, tests).
 */
export function useRunnerCliLogin(): UseMutationResult<
  void,
  Error,
  CliLoginVariables
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const cicCli = runnerHost.cicCli;
  return useMutation<void, Error, CliLoginVariables>({
    mutationKey: runnerMutationKeys.cicCliLogin(),
    mutationFn: async ({ token, refreshToken }) => {
      if (cicCli === null) return;
      await cicCli.cliLogin(token, refreshToken);
    },
    onSuccess: () => {
      if (cicCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.cicHostStatus(cicCli),
      });
    },
  });
}
