import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reader for the local Traycer host's pid metadata.
 *
 * Mirror of the CLI's on-disk contract (clients/traycer-cli/src/host/
 * pid-metadata.ts + store/paths.ts `hostHomeDir`): the host writes
 * `~/.traycer/host/pid.json` for production and `~/.traycer/host/<env>/
 * pid.json` for other environments. Duplicated here because the CLI package
 * is not imported cross-workspace by convention; keep the shapes in lockstep
 * with the CLI files above. (The CLI's multi-run `dev-runs/<slot>` layout is
 * intentionally not handled - `make dev-desktop` slots are a desktop-dev
 * concern, not a serve target.)
 */
export interface HostPidMetadata {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
}

export function hostPidMetadataPath(environment: string): string {
  const hostHome = join(homedir(), ".traycer", "host");
  const environmentHome =
    environment === "production" ? hostHome : join(hostHome, environment);
  return join(environmentHome, "pid.json");
}

export async function readHostPidMetadata(
  environment: string,
): Promise<HostPidMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(hostPidMetadataPath(environment), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.pid !== "number" ||
    typeof obj.hostId !== "string" ||
    typeof obj.version !== "string" ||
    typeof obj.websocketUrl !== "string" ||
    typeof obj.startedAt !== "string"
  ) {
    return null;
  }
  if (!isValidLocalHostWebsocketUrl(obj.websocketUrl)) {
    return null;
  }
  return {
    pid: obj.pid,
    hostId: obj.hostId,
    version: obj.version,
    websocketUrl: obj.websocketUrl,
    startedAt: obj.startedAt,
  };
}

/**
 * Mirror of the CLI's `isValidLocalHostWebsocketUrl`: the host binds
 * `ws://127.0.0.1:<port>/rpc` only. Enforced before the serve process dials
 * the upstream so a corrupted pid.json can never redirect the proxy at an
 * arbitrary address.
 */
export function isValidLocalHostWebsocketUrl(websocketUrl: string): boolean {
  if (!URL.canParse(websocketUrl)) {
    return false;
  }
  const parsed = new URL(websocketUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }
  if (parsed.hostname !== "127.0.0.1") {
    return false;
  }
  if (parsed.pathname !== "/rpc") {
    return false;
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    return false;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  if (parsed.port.length === 0) {
    return false;
  }
  const port = Number.parseInt(parsed.port, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Upstream dial URL for one of the host's two WebSocket endpoints. The host
 * publishes only the `/rpc` URL in pid.json; the stream endpoint is the same
 * origin with the `/rpc` suffix swapped for `/stream` (the exact rewrite
 * `toStreamDialUrl` in clients/shared/host-transport/ws-stream-client.ts
 * applies on the client side).
 */
export function upstreamHostUrl(
  metadata: HostPidMetadata,
  endpoint: "rpc" | "stream",
): string {
  if (endpoint === "rpc") {
    return metadata.websocketUrl;
  }
  return `${metadata.websocketUrl.slice(0, -"/rpc".length)}/stream`;
}
