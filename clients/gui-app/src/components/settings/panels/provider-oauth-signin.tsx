import { useId, useState, type ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderId,
} from "@cic/protocol/host/provider-schemas";
import { PROVIDER_DISPLAY_NAMES } from "@cic/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useProvidersStartLogin } from "@/hooks/providers/use-providers-start-login-mutation";
import { useProvidersAwaitLoginScoped } from "@/hooks/providers/use-providers-await-login-scoped-mutation";
import { useProvidersCancelLogin } from "@/hooks/providers/use-providers-cancel-login-mutation";

/**
 * Settings-panel "Sign in" control for a CLI provider that advertises an
 * OAuth login (`loginCapability.oauthArgs`). Mirrors the composer reauth
 * banner's flow: `startLogin` launches the CLI's browser-OAuth child and
 * returns the URL it prints; the host blocks `awaitLogin` until that child
 * exits (the honest "login finished" edge), then re-probes. Renders nothing
 * for providers without an OAuth flow (e.g. OpenClaw, key-only providers).
 *
 * The child's OAuth callback lands on a `http://localhost:PORT/…` loopback
 * served on the HOST. On a remote host that loopback is unreachable from the
 * user's browser, so the redirect dead-ends; the user copies that callback URL
 * and pastes it here, and the host replays it against its own loopback to
 * finish the flow (`providers.startLogin` with a non-null `callbackUrl`).
 */
export function ProviderOAuthSignIn({
  state,
}: {
  readonly state: ProviderCliState;
}): ReactNode {
  const providerId: ProviderId = state.providerId;
  const oauthArgs = state.loginCapability?.oauthArgs ?? null;
  const callbackInputId = useId();
  const startLogin = useProvidersStartLogin();
  const awaitLogin = useProvidersAwaitLoginScoped();
  const cancelLogin = useProvidersCancelLogin();
  const { copied, copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: null,
    onError: null,
  });
  const [awaiting, setAwaiting] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [callbackDraft, setCallbackDraft] = useState("");
  const [callbackError, setCallbackError] = useState<string | null>(null);

  const { mutate: awaitLoginMutate } = awaitLogin;
  const { mutate: cancelLoginMutate } = cancelLogin;

  if (oauthArgs === null || oauthArgs.length === 0) {
    return null;
  }

  const onSignIn = (): void => {
    if (startLogin.isPending || awaiting) {
      return;
    }
    setCallbackDraft("");
    setCallbackError(null);
    startLogin.mutate(
      { providerId, callbackUrl: null },
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

  // Deliver the pasted browser callback to the login child already in flight.
  // Success (`callbackDelivered`) makes the child complete and exit, which the
  // in-flight `awaitLogin` reaps; a false result means nothing was listening,
  // so the URL was likely stale or from the wrong provider.
  const onSubmitCallback = (): void => {
    const trimmed = callbackDraft.trim();
    if (trimmed.length === 0 || startLogin.isPending) {
      return;
    }
    setCallbackError(null);
    startLogin.mutate(
      { providerId, callbackUrl: trimmed },
      {
        onSuccess: (data) => {
          if (data.callbackDelivered === false) {
            setCallbackError(
              "Couldn't complete sign-in — the URL may be stale. Start again.",
            );
          }
        },
      },
    );
  };

  const onCancel = (): void => {
    cancelLoginMutate({ providerId });
    setAwaiting(false);
    setCallbackDraft("");
    setCallbackError(null);
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
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-ui-sm text-foreground">
            <MutedAgentSpinner />
            <span>Waiting for browser sign-in…</span>
          </div>
          {loginUrl !== null ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-ui-xs text-muted-foreground">
                Open this link to sign in (it opens on the device you&apos;re
                using now). If it doesn&apos;t open, copy it into your browser:
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {/* A real anchor, not `window.open`: programmatic opens are
                    popup-blocked on many (esp. mobile) browsers even from a
                    click, so the link navigation is the reliable path. */}
                <Button asChild size="sm" variant="secondary">
                  <a href={loginUrl} target="_blank" rel="noopener noreferrer">
                    Open sign-in page
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => copy(loginUrl)}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
              <span className="w-full select-all break-all rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-ui-xs text-muted-foreground">
                {loginUrl}
              </span>
            </div>
          ) : (
            <span className="text-ui-xs text-muted-foreground">
              No sign-in link was printed by the CLI. Cancel and try again, or
              run the login from the host&apos;s terminal.
            </span>
          )}
          <div>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={callbackInputId}
              className="text-ui-xs font-medium text-foreground"
            >
              Finish on another device? Paste the callback URL
            </label>
            <span className="text-ui-xs text-muted-foreground">
              After signing in, your browser lands on a{" "}
              <span className="font-mono">localhost</span> page (it may show an
              error). Copy that address and paste it here to complete sign-in.
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={callbackInputId}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 font-mono text-ui-sm"
                placeholder="http://localhost:1455/callback?code=…"
                value={callbackDraft}
                onChange={(event) => {
                  setCallbackDraft(event.target.value);
                  if (callbackError !== null) setCallbackError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSubmitCallback();
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={onSubmitCallback}
                disabled={
                  startLogin.isPending || callbackDraft.trim().length === 0
                }
              >
                {startLogin.isPending ? <MutedAgentSpinner /> : null}
                Complete sign-in
              </Button>
            </div>
            {callbackError !== null ? (
              <span className="text-ui-xs text-destructive">
                {callbackError}
              </span>
            ) : null}
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
