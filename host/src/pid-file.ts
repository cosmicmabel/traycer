import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * pid.json writer - the host side of the on-disk contract the CLI, desktop,
 * and web serve process read (`clients/traycer-cli/src/host/pid-metadata.ts`):
 * `{ pid, hostId, version, websocketUrl, startedAt }` at
 * `~/.traycer/host/pid.json` (production) or `~/.traycer/host/<env>/pid.json`.
 *
 * `hostId` ≡ deviceId (see CLAUDE.md "host identity model"), so it must be
 * stable across restarts: it is minted once and persisted next to pid.json.
 */
export function hostHomeDir(environment: string): string {
  const base = join(homedir(), ".traycer", "host");
  return environment === "production" ? base : join(base, environment);
}

const HOST_ID_FILENAME = "open-host-id.json";

export async function loadOrMintHostId(environment: string): Promise<string> {
  const dir = hostHomeDir(environment);
  const path = join(dir, HOST_ID_FILENAME);
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const hostId = Reflect.get(parsed, "hostId");
      if (typeof hostId === "string" && hostId.length > 0) {
        return hostId;
      }
    }
  } catch {
    // Missing or unreadable - mint below.
  }
  const hostId = randomUUID();
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify({ hostId }), "utf8");
  return hostId;
}

export interface PidFileInput {
  readonly environment: string;
  readonly hostId: string;
  readonly version: string;
  readonly port: number;
}

export async function writePidFile(input: PidFileInput): Promise<string> {
  const dir = hostHomeDir(input.environment);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "pid.json");
  const payload = {
    pid: process.pid,
    hostId: input.hostId,
    version: input.version,
    websocketUrl: `ws://127.0.0.1:${input.port}/rpc`,
    startedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(payload), "utf8");
  return path;
}

export async function removePidFile(environment: string): Promise<void> {
  await rm(join(hostHomeDir(environment), "pid.json"), { force: true });
}
