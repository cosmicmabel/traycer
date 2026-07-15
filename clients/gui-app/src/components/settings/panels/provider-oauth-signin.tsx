import { useState, type ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderId,
} from "@cic/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@cic/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useProvidersStartLogin } from "@/hooks/providers/use-providers-start-login-mutation";
import { useProvidersAwaitLoginScoped } from "@/hooks/providers/use-providers-await-login-scoped-mutation";
import { useProvidersCancelLogin } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * Settings-panel "Sign in" control for a CLI provider that advertises an
 * OAuth login (`loginCapability.oauthArgs`). Mirrors the composer reauth
 * banner's flow: `startLogin` launches the CLI's browser-OAuth child and
 * returns the URL it prints; the host blocks `awaitLogin` until that child
 * exits (the honest "login finished" edge), then re-probes. Renders nothing
 * for providers without an OAuth flow (e.g. OpenClaw, key-only providers).
 */
export function ProviderOAuthSignIn({
  state,
}: {
  readonly state: ProviderCliState;
}): ReactNode {
  const providerId: ProviderId = state.providerId;
  const oauthArgs = state.loginCapability?.oauthArgs ?? null;
  const startLogin = useProvidersStartLogin();
  const awaitLogin = useProvidersAwaitLoginScoped();
  const cancelLogin = useProvidersCancelLogin();
  const runnerHost = useRunnerHost();
  const [awaiting, setAwaiting] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  const { mutate: awaitLoginMutate } = awaitLogin;
  const { mutate: cancelLoginMutate } = cancelLogin;

  if (oauthArgs === null || oauthArgs.length === 0) {
    return null;
  }

  const onSignIn = (): void => {
    if (startLogin.isPending || awaiting) {
      return;
    }
    startLogin.mutate(
      { providerId },
      {
        onSuccess: (data) => {
          setLoginUrl(data.url);
          setAwaiting(true);
          // Wait on the child's exit rather than polling; `onSettled` drops
          // the spinner whether login succeeded or the user bailed.
          awaitLoginMutate(
            { providerId },
            { onSettled: () => setAwaiting(false) },
          );
        },
      },
    );
  };

  const onCancel = (): void => {
    cancelLoginMutate({ providerId });
    setAwaiting(false);
  };

  const label = PROVIDER_DISPLAY_NAMES[providerId];

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-foreground">Sign in</span>
        <span className="text-ui-xs text-muted-foreground">
          Sign in to {label} with your account (opens a browser). Runs the CLI's
          own login on this machine.
        </span>
      </div>
      {awaiting ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-ui-sm text-foreground">
            <MutedAgentSpinner />
            <span>Waiting for browser sign-in…</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {loginUrl !== null ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void runnerHost.openExternalLink(loginUrl)}
              >
                Open sign-in page
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onSignIn}
            disabled={startLogin.isPending}
          >
            {startLogin.isPending ? <MutedAgentSpinner /> : null}
            Sign in with {label}
          </Button>
        </div>
      )}
    </div>
  );
}
