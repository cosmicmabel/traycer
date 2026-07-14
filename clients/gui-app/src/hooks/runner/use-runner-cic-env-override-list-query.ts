import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { ICicCli, CicEnvOverride } from "@cic/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

function cicEnvOverrideListQueryOptions(cicCli: ICicCli | null) {
  return queryOptions<readonly CicEnvOverride[]>({
    queryKey:
      cicCli !== null
        ? runnerQueryKeys.cicEnvOverrideList(cicCli)
        : ["runner.cic.envOverrideList", "disabled"],
    queryFn: () => {
      if (cicCli === null) {
        throw new Error("cicCli unavailable on this runner host");
      }
      return cicCli.envOverrideList();
    },
    enabled: cicCli !== null,
  });
}

/**
 * Reads all env overrides through `cic config env list`. Powers the
 * env table in Settings → Shell & environment.
 */
export function useRunnerCicEnvOverrideListQuery(): UseQueryResult<
  readonly CicEnvOverride[]
> {
  const runnerHost = useRunnerHost();
  return useQuery(cicEnvOverrideListQueryOptions(runnerHost.cicCli));
}
