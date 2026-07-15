import { useState, type FormEvent, type ReactNode } from "react";

/**
 * The web shell's local password gate.
 *
 * Rendered by main.tsx INSTEAD of the app whenever the serve process
 * reports an unauthenticated session (`GET /api/auth/status`). Two modes,
 * chosen by whether a password exists yet:
 *  - first visit → "create a password" (POST /api/auth/setup)
 *  - later visits → "unlock" (POST /api/auth/login)
 * Success sets the HttpOnly session cookie server-side; the page reloads
 * and the normal bootstrap proceeds. This is a machine-local password, not
 * an account - see src/server/web-auth.ts for the security model.
 */

export interface WebAuthStatus {
  readonly authRequired: boolean;
  readonly passwordSet: boolean;
  readonly authenticated: boolean;
}

export async function fetchAuthStatus(): Promise<WebAuthStatus | null> {
  let response: Response;
  try {
    response = await fetch("/api/auth/status", {
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.authRequired !== "boolean" ||
    typeof record.passwordSet !== "boolean" ||
    typeof record.authenticated !== "boolean"
  ) {
    return null;
  }
  return {
    authRequired: record.authRequired,
    passwordSet: record.passwordSet,
    authenticated: record.authenticated,
  };
}

export function LoginScreen({
  passwordSet,
}: {
  readonly passwordSet: boolean;
}): ReactNode {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const creating = !passwordSet;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (creating && password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    let response: Response;
    try {
      response = await fetch(creating ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
    } catch {
      setPending(false);
      setError("Couldn't reach the CIC server.");
      return;
    }
    if (response.ok) {
      // The session cookie is set; a clean reload runs the normal bootstrap.
      window.location.reload();
      return;
    }
    setPending(false);
    setError(await response.text());
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex w-[min(92vw,22rem)] flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">CIC</h1>
          <p className="text-sm text-muted-foreground">
            {creating
              ? "Set a password to protect this machine's CIC. You'll use it to unlock the app from now on."
              : "Enter your password to unlock."}
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            autoFocus
            autoComplete={creating ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-11 rounded-md border bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {creating ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Confirm password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="h-11 rounded-md border bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending || password.length === 0}
          className="h-11 rounded-md bg-primary text-base font-medium text-primary-foreground transition-opacity disabled:opacity-50"
        >
          {creating ? "Set password & enter" : "Unlock"}
        </button>
        {creating ? (
          <p className="text-xs text-muted-foreground">
            Forgot it later? Delete <code>~/.cic/web-auth.json</code> on the
            server machine and reload to set a new one.
          </p>
        ) : null}
      </form>
    </div>
  );
}
