import { z } from "zod";

/**
 * Runtime config served by the Bun serve process (`GET /api/runtime-config`,
 * src/server/serve.ts). Fetched at bootstrap and then polled by
 * `BrowserRunnerHost.onLocalHostChange` so the page tracks host
 * restarts/upgrades without a reload.
 *
 * `host` mirrors the host's pid.json (`~/.cic/host[/…]/pid.json`) minus
 * the loopback `websocketUrl`: the host binds 127.0.0.1 only, so the browser
 * always dials the serve process's same-origin `/host/rpc` proxy instead. The
 * shell composes that URL from `window.location` (see
 * `hostWebsocketUrlFromLocation`) so port-forwards and reverse proxies keep
 * working regardless of what address the serve process thinks it has.
 */
export const webRuntimeConfigSchema = z.object({
  systemHostName: z.string(),
  host: z
    .object({
      hostId: z.string().min(1),
      version: z.string(),
      pid: z.number(),
      startedAt: z.string(),
    })
    .nullable(),
});
export type WebRuntimeConfig = z.infer<typeof webRuntimeConfigSchema>;

export const RUNTIME_CONFIG_PATH = "/api/runtime-config";

export async function fetchRuntimeConfig(): Promise<WebRuntimeConfig | null> {
  let response: Response;
  try {
    response = await fetch(RUNTIME_CONFIG_PATH, {
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
  const parsed = webRuntimeConfigSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/**
 * Same-origin WebSocket URL of the serve process's `/host/rpc` proxy.
 * `toStreamDialUrl` (clients/shared/host-transport/ws-stream-client.ts)
 * rewrites the `/rpc` suffix to `/stream`, so this single advertised URL
 * covers both the unary RPC socket and the stream socket.
 */
export function hostWebsocketUrlFromLocation(location: Location): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/host/rpc`;
}
