import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { ICicCli, CicShellConfig } from "@cic/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

function cicShellConfigQueryOptions(cicCli: ICicCli | null) {
  return queryOptions<CicShellConfig>({
    queryKey:
      cicCli !== null
        ? runnerQueryKeys.cicShellConfig(cicCli)
        : ["runner.cic.shellConfig", "disabled"],
    queryFn: () => {
      if (cicCli === null) {
        throw new Error("cicCli unavailable on this runner host");
      }
      return cicCli.shellConfigGet();
    },
    enabled: cicCli !== null,
  });
}

/**
 * Reads the effective shell config (path + args + synthesised flag) through
 * `cic config shell get`. Drives the Settings → Shell & environment form
 * and the bootstrap-failure card's "shell that was attempted" line.
 *
 * Disabled when `cicCli === null`.
 */
export function useRunnerCicShellConfigQuery(): UseQueryResult<CicShellConfig> {
  const runnerHost = useRunnerHost();
  return useQuery(cicShellConfigQueryOptions(runnerHost.cicCli));
}
