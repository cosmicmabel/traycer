import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CicApp, hostRpcRegistry } from "@cic/gui-app";
import "./index.css";
import { fetchAuthStatus, LoginScreen } from "./auth-gate";
import { BrowserRunnerHost } from "./browser-runner-host";
import { ensureLocalSessionSeeded } from "./local-session";
import { fetchRuntimeConfig, RUNTIME_CONFIG_PATH } from "./runtime-config";

/**
 * Web shell entry point. Unlike the desktop renderer there is no preload
 * bridge (`window.runnerHost`): the shell's capabilities are constructed
 * in-page from the runtime config served by the Bun serve process
 * (src/server/serve.ts), then handed to the shell-agnostic `<CicApp />`.
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("#root element not found in index.html");
  }

  // Machine-local password gate (serve process, web-auth.ts): if this
  // browser has no session, render the login screen instead of the app.
  // A successful login sets the HttpOnly cookie and reloads the page.
  const authStatus = await fetchAuthStatus();
  if (
    authStatus !== null &&
    authStatus.authRequired &&
    !authStatus.authenticated
  ) {
    createRoot(container).render(
      <StrictMode>
        <LoginScreen passwordSet={authStatus.passwordSet} />
      </StrictMode>,
    );
    return;
  }

  const config = await fetchRuntimeConfig();
  if (config === null) {
    container.textContent =
      `CIC web shell could not load ${RUNTIME_CONFIG_PATH}. ` +
      "Serve this page through `cic-web serve` (clients/web) instead of a plain static file server.";
    return;
  }

  const host = new BrowserRunnerHost({ config });

  // Seed the constant local credential BEFORE the app renders so
  // `AuthService.start()` rehydrates straight into the signed-in state -
  // there is no login screen, ever.
  await ensureLocalSessionSeeded(host.tokenStore);

  createRoot(container).render(
    <StrictMode>
      <CicApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={null}
        initialRoute={null}
      />
    </StrictMode>,
  );
}

void bootstrap();
