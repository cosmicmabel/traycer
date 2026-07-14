import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ICicCli,
  CicDetectedShell,
} from "@cic/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

function cicShellListQueryOptions(cicCli: ICicCli | null) {
  return queryOptions<readonly CicDetectedShell[]>({
    queryKey:
      cicCli !== null
        ? runnerQueryKeys.cicShellList(cicCli)
        : ["runner.cic.shellList", "disabled"],
    queryFn: () => {
      if (cicCli === null) {
        throw new Error("cicCli unavailable on this runner host");
      }
      return cicCli.shellListDetected();
    },
    enabled: cicCli !== null,
    // Installed shells change rarely; cache for the session. The combobox
    // always accepts a typed custom path, so a stale or empty list is benign.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Lists shells detected on this machine (`cic config shell list`) to
 * populate the Settings → Shell quick-picks. Disabled when
 * `cicCli === null` (mobile/web hosts).
 */
export function useRunnerCicShellListQuery(): UseQueryResult<
  readonly CicDetectedShell[]
> {
  const runnerHost = useRunnerHost();
  return useQuery(cicShellListQueryOptions(runnerHost.cicCli));
}
