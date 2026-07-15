import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@cic/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

/**
 * Host-scoped `providers.awaitLogin` for surfaces that aren't tab-bound (the
 * Settings › Providers panel). The tab-scoped `useProvidersAwaitLogin` reads
 * `useTabHostId`, which throws outside a `<TabHostProvider>`; this variant
 * targets the app's default host via `useHostScopedMutation` and invalidates
 * `providers.list` on success so the panel re-reads the freshly-probed state
 * once the login child closes.
 */
export function useProvidersAwaitLoginScoped(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.awaitLogin">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.awaitLogin",
    mutationKey: providersMutationKeys.awaitLogin(),
    errorMessage: "Couldn't confirm sign-in.",
    invalidateMethods: ["providers.list"],
  });
}
