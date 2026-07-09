import { OPEN_HOST_VERSION, parseOpenHostArgs } from "./config";
import { loadOrMintHostId, removePidFile, writePidFile } from "./pid-file";
import { startOpenHostServer } from "./server";

/**
 * `bun host/src/index.ts [--port N] [--environment production] [--authn-url …]
 *   [--insecure-no-auth] [--openclaw-gateway-url ws://127.0.0.1:18789]
 *   [--openclaw-gateway-token …]`
 *
 * Starts the open-source Traycer host, writes the pid.json the clients
 * discover it through, and removes it again on shutdown.
 */
async function main(): Promise<void> {
  const config = parseOpenHostArgs(process.argv.slice(2));
  const hostId = await loadOrMintHostId(config.environment);
  const server = startOpenHostServer(config);
  const pidPath = await writePidFile({
    environment: config.environment,
    hostId,
    version: OPEN_HOST_VERSION,
    port: server.port,
  });

  console.log(
    `open host ${OPEN_HOST_VERSION} listening on ws://127.0.0.1:${server.port}/rpc (hostId ${hostId}, pid file ${pidPath})`,
  );
  if (config.insecureNoAuth) {
    console.warn(
      "WARNING: --insecure-no-auth accepts ANY bearer token; use only for offline development.",
    );
  }

  const shutdown = (): void => {
    void removePidFile(config.environment).finally(() => {
      server.stop();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
