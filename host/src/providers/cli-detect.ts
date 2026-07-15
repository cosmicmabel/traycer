/**
 * CLI provider detection.
 *
 * The host runs agent turns by shelling out to each vendor's own CLI
 * (`claude`, `codex`, `grok`), so a provider is "available" when its binary
 * is on PATH (or at an operator-configured custom path) and answers
 * `--version`. This module probes those binaries and caches the verdict so
 * `providers.list` / `agent.gui.listHarnesses` stay cheap.
 *
 * Auth is the CLI's own concern: `claude`/`codex`/`grok` each manage their
 * own login/credentials, exactly as they do in a terminal. The host only
 * cares that the binary exists and runs.
 */

/** Harness ids the host can drive by spawning a CLI (OpenClaw is separate). */
export const CLI_HARNESS_IDS = ["claude", "codex", "grok"] as const;
export type CliHarnessId = (typeof CLI_HARNESS_IDS)[number];

/**
 * Default binary name per harness. `claude` is Claude Code, `codex` is the
 * OpenAI Codex CLI, `grok` is xAI's Grok CLI. Operators can point at a
 * different path through the provider's custom paths (see provider settings).
 */
const DEFAULT_BINARY: Record<CliHarnessId, string> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
};

export interface CliDetection {
  readonly harnessId: CliHarnessId;
  /** Resolved binary path (or bare name) that answered `--version`. */
  readonly binary: string | null;
  readonly version: string | null;
  readonly available: boolean;
}

export function isCliHarnessId(value: string): value is CliHarnessId {
  return (CLI_HARNESS_IDS as readonly string[]).includes(value);
}

/** Seam so tests can inject a fake process runner instead of real spawns. */
export interface VersionProbe {
  probe(binary: string): Promise<string | null>;
}

const VERSION_TIMEOUT_MS = 5_000;

export const bunVersionProbe: VersionProbe = {
  async probe(binary: string): Promise<string | null> {
    try {
      const proc = Bun.spawn([binary, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        // Never inherit stdin; a misbehaving binary must not block on it.
        stdin: "ignore",
      });
      const timer = setTimeout(() => proc.kill(), VERSION_TIMEOUT_MS);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      if (exitCode !== 0) {
        return null;
      }
      const text = await new Response(proc.stdout).text();
      const line = text.split("\n")[0]?.trim() ?? "";
      return line.length > 0 ? line : "installed";
    } catch {
      // ENOENT (not on PATH) or spawn failure → not available.
      return null;
    }
  },
};

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  readonly detection: CliDetection;
  readonly expiresAt: number;
}

export class CliDetector {
  private readonly probe: VersionProbe;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(probe: VersionProbe) {
    this.probe = probe;
  }

  /**
   * Detects one harness. `customPaths` are tried before the default binary
   * name, so an operator override wins; the first path that answers
   * `--version` is reported.
   */
  async detect(
    harnessId: CliHarnessId,
    customPaths: readonly string[],
  ): Promise<CliDetection> {
    const candidates = [...customPaths, DEFAULT_BINARY[harnessId]];
    const cacheKey = `${harnessId}:${candidates.join(":")}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.detection;
    }
    let detection: CliDetection = {
      harnessId,
      binary: null,
      version: null,
      available: false,
    };
    for (const binary of candidates) {
      const version = await this.probe.probe(binary);
      if (version !== null) {
        detection = { harnessId, binary, version, available: true };
        break;
      }
    }
    this.cache.set(cacheKey, {
      detection,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return detection;
  }
}
