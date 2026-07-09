import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TraycerApp, hostRpcRegistry } from "@traycer-clients/gui-app";
import "./index.css";
import { BrowserRunnerHost } from "./browser-runner-host";
import { fetchRuntimeConfig, RUNTIME_CONFIG_PATH } from "./runtime-config";

/**
 * Web shell entry point. Unlike the desktop renderer there is no preload
 * bridge (`window.runnerHost`): the shell's capabilities are constructed
 * in-page from the runtime config served by the Bun serve process
 * (src/server/serve.ts), then handed to the shell-agnostic `<TraycerApp />`.
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("#root element not found in index.html");
  }

  const config = await fetchRuntimeConfig();
  if (config === null) {
    container.textContent =
      `Traycer web shell could not load ${RUNTIME_CONFIG_PATH}. ` +
      "Serve this page through `traycer-web serve` (clients/web) instead of a plain static file server.";
    return;
  }

  const host = new BrowserRunnerHost({ config });

  createRoot(container).render(
    <StrictMode>
      <TraycerApp
        runnerHost={host}
        registry={hostRpcRegistry}
        remoteFetcher={null}
        initialRoute={null}
      />
    </StrictMode>,
  );
}

void bootstrap();
