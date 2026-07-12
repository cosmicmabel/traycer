import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  PROVIDER_DISPLAY_NAMES,
  providerEnvOverrideSchema,
  providerIdSchema,
  providerSelectionSchema,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { hostHomeDir } from "../pid-file";

/**
 * Per-provider user settings behind the `providers.set*` mutations,
 * persisted to a JSON file and merged into every `ProviderCliState` the
 * host reports (providers.list and each mutation's `{state}` echo).
 *
 * The open host only runs the OpenClaw provider; other providers accept
 * settings (they persist and round-trip) but stay unavailable — the
 * settings panel edits work, the harness just can't launch them.
 */
const settingsRowSchema = z.object({
  providerId: providerIdSchema,
  // null = default (openclaw on, everything else off).
  enabled: z.boolean().nullable(),
  terminalAgentArgs: z.string(),
  envOverrides: z.array(providerEnvOverrideSchema),
  apiKey: z.string().nullable(),
  customPaths: z.array(z.string()),
  selection: providerSelectionSchema,
});
export type ProviderSettingsRow = z.infer<typeof settingsRowSchema>;

const settingsFileSchema = z.object({ rows: z.array(settingsRowSchema) });

function defaultRow(providerId: ProviderId): ProviderSettingsRow {
  return {
    providerId,
    enabled: null,
    terminalAgentArgs: "",
    envOverrides: [],
    apiKey: null,
    customPaths: [],
    selection: { kind: "bundled" },
  };
}

export class ProviderSettingsStore {
  private readonly environment: string;
  private rows: ProviderSettingsRow[] | null = null;

  constructor(environment: string) {
    this.environment = environment;
  }

  async get(providerId: ProviderId): Promise<ProviderSettingsRow> {
    const rows = await this.loadAll();
    return (
      rows.find((row) => row.providerId === providerId) ??
      defaultRow(providerId)
    );
  }

  async mutate(
    providerId: ProviderId,
    updater: (row: ProviderSettingsRow) => ProviderSettingsRow,
  ): Promise<ProviderSettingsRow> {
    const rows = await this.loadAll();
    const current =
      rows.find((row) => row.providerId === providerId) ??
      defaultRow(providerId);
    const next = updater(current);
    this.rows = [...rows.filter((row) => row.providerId !== providerId), next];
    await this.save();
    return next;
  }

  private async loadAll(): Promise<ProviderSettingsRow[]> {
    if (this.rows !== null) {
      return this.rows;
    }
    let parsed: ProviderSettingsRow[] = [];
    try {
      const raw = await readFile(this.filePath(), "utf8");
      const file = settingsFileSchema.safeParse(JSON.parse(raw));
      if (file.success) {
        parsed = file.data.rows;
      }
    } catch {
      // Missing/corrupt store starts with defaults.
    }
    this.rows = parsed;
    return parsed;
  }

  private async save(): Promise<void> {
    if (this.rows === null) {
      return;
    }
    try {
      await mkdir(hostHomeDir(this.environment), { recursive: true });
      await writeFile(
        this.filePath(),
        JSON.stringify({ rows: this.rows }),
        "utf8",
      );
    } catch {
      // Best-effort persistence; the in-memory rows stay authoritative.
    }
  }

  private filePath(): string {
    return join(
      hostHomeDir(this.environment),
      "open-host-provider-settings.json",
    );
  }
}

/**
 * Builds the wire `ProviderCliState` from a settings row. `gatewayReachable`
 * only matters for the openclaw provider — the sole provider this host can
 * actually run.
 */
export function buildProviderState(
  row: ProviderSettingsRow,
  gatewayReachable: boolean,
): ProviderCliState {
  const isOpenClaw = row.providerId === "openclaw";
  const enabled = row.enabled ?? isOpenClaw;
  const available = isOpenClaw && enabled && gatewayReachable;
  return {
    providerId: row.providerId,
    enabled,
    disabledBy: null,
    selected: row.selection,
    candidates: row.customPaths.map((path) => ({
      kind: "custom" as const,
      path,
      version: null,
      available: false,
      versionPending: false,
    })),
    auth: {
      status: available ? "authenticated" : enabled ? "unknown" : "unavailable",
      badgeText: null,
      label: available ? PROVIDER_DISPLAY_NAMES[row.providerId] : null,
      detail: isOpenClaw
        ? available
          ? "Local OpenClaw Gateway"
          : "Start the OpenClaw Gateway to enable this provider"
        : "Not implemented in @traycer/open-host yet",
    },
    authPending: false,
    checkedAt: Date.now(),
    apiKey: {
      supported: true,
      configured: row.apiKey !== null,
      source: row.apiKey !== null ? "stored" : null,
    },
    terminalAgentArgs: row.terminalAgentArgs,
    envOverrides: row.envOverrides,
    loginCapability: null,
    availabilityPending: false,
  };
}
