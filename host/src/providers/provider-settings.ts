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
} from "@cic/protocol/host/provider-schemas";
import { hostHomeDir } from "../pid-file";
import { CLI_LOGIN } from "./login-process";

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
 * Availability inputs for one provider, resolved by the host before building
 * wire state:
 *  - `gateway` (openclaw): the local OpenClaw Gateway probe succeeded.
 *  - `cli` (claude-code/codex/grok): the vendor CLI answered `--version`.
 * A provider with neither kind is a settings-only row (edits persist, but the
 * host can't run it).
 */
export type ProviderAvailability =
  | { readonly kind: "none" }
  | { readonly kind: "gateway"; readonly reachable: boolean }
  | {
      readonly kind: "cli";
      readonly detected: boolean;
      readonly binary: string | null;
      readonly version: string | null;
    };

/** Builds the wire `ProviderCliState` from a settings row + availability. */
export function buildProviderState(
  row: ProviderSettingsRow,
  availability: ProviderAvailability,
): ProviderCliState {
  const runnable =
    availability.kind === "gateway"
      ? availability.reachable
      : availability.kind === "cli"
        ? availability.detected
        : false;
  const enabled = row.enabled ?? availability.kind !== "none";
  const available = enabled && runnable;
  return {
    providerId: row.providerId,
    enabled,
    disabledBy: null,
    selected: row.selection,
    candidates: cliCandidates(row, availability),
    auth: {
      status: available ? "authenticated" : enabled ? "unknown" : "unavailable",
      badgeText:
        availability.kind === "cli" && availability.version !== null
          ? availability.version
          : null,
      label: available ? PROVIDER_DISPLAY_NAMES[row.providerId] : null,
      detail: availabilityDetail(availability),
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
    loginCapability: cliLoginCapability(row.providerId),
    availabilityPending: false,
  };
}

/**
 * The OAuth/token reconnect affordance for a CLI provider (drives the GUI's
 * "Sign in" button + token-paste field). `null` for non-CLI providers.
 */
function cliLoginCapability(
  providerId: ProviderId,
): ProviderCliState["loginCapability"] {
  const harnessId =
    providerId === "claude-code"
      ? "claude"
      : providerId === "codex"
        ? "codex"
        : providerId === "grok"
          ? "grok"
          : null;
  if (harnessId === null) {
    return null;
  }
  const config = CLI_LOGIN[harnessId];
  return {
    oauthArgs: config.oauthArgs === null ? null : [...config.oauthArgs],
    token: { vars: [...config.tokenVars] },
  };
}

function cliCandidates(
  row: ProviderSettingsRow,
  availability: ProviderAvailability,
): ProviderCliState["candidates"] {
  const custom = row.customPaths.map((path) => ({
    kind: "custom" as const,
    path,
    version: null,
    available: false,
    versionPending: false,
  }));
  if (
    availability.kind === "cli" &&
    availability.detected &&
    availability.binary !== null &&
    !row.customPaths.includes(availability.binary)
  ) {
    return [
      {
        kind: "path" as const,
        path: availability.binary,
        version: availability.version,
        available: true,
        versionPending: false,
      },
      ...custom,
    ];
  }
  return custom;
}

function availabilityDetail(availability: ProviderAvailability): string | null {
  if (availability.kind === "gateway") {
    return availability.reachable
      ? "Local OpenClaw Gateway"
      : "Start the OpenClaw Gateway to enable this provider";
  }
  if (availability.kind === "cli") {
    return availability.detected
      ? "Detected on PATH — turns run through the vendor CLI (sign in with the CLI itself)"
      : "CLI not found on PATH — install it or add a custom path";
  }
  return "Not runnable by @cic/open-host — settings persist but this agent can't launch here";
}
