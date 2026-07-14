import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ICicCli,
  CicHostStatusSnapshot,
} from "@cic/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys";

export interface UseRunnerCicHostStatusQueryOptions {
  /**
   * Refetch interval in ms while the query is mounted. `null` disables
   * polling (default - used by the failure card so it doesn't keep
   * re-fetching while the user reads it). The loading screen passes a
   * short interval so the bootstrap.log tail stays fresh while the
   * host is starting up.
   */
  readonly pollIntervalMs: number | null;
}

function cicHostStatusQueryOptions(
  cicCli: ICicCli | null,
  pollIntervalMs: number | null,
) {
  return queryOptions<CicHostStatusSnapshot>({
    queryKey:
      cicCli !== null
        ? runnerQueryKeys.cicHostStatus(cicCli)
        : ["runner.cic.hostStatus", "disabled"],
    queryFn: () => {
      if (cicCli === null) {
        throw new Error("cicCli unavailable on this runner host");
      }
      return cicCli.hostStatus();
    },
    enabled: cicCli !== null,
    // Bootstrap state changes only on host (re)spawn or as bootstrap.log
    // gets new lines. With pollIntervalMs set, refetchInterval drives
    // freshness. Without it, callers get the cached value until next
    // explicit invalidate.
    staleTime: pollIntervalMs !== null ? 0 : 30_000,
    refetchInterval: pollIntervalMs ?? false,
  });
}

/**
 * Reads `cic host status` through the runner-host CLI bridge. Host-
 * independent: works whether the host is up, starting, or wedged.
 * Consumers:
 *   - `LocalHostLoading` - polls while the gate is in `loading` / `slow`
 *     so the live bootstrap.log tail and recent markers stay fresh.
 *   - `LocalHostUnavailable` (failure card) - single read; the renderer
 *     stops driving updates while the user reads the diagnostics.
 *
 * Disabled on shells without a CLI (mobile, web) - `cicCli === null`.
 */
export function useRunnerCicHostStatusQuery(
  opts: UseRunnerCicHostStatusQueryOptions,
): UseQueryResult<CicHostStatusSnapshot> {
  const runnerHost = useRunnerHost();
  return useQuery(
    cicHostStatusQueryOptions(runnerHost.cicCli, opts.pollIntervalMs),
  );
}
