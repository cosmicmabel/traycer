/**
 * Runtime configuration for the open host. Flat and flag-driven: the open
 * host is a self-hosted server, so unlike the desktop/CLI builds there is no
 * deploy-script stamping - operators pass flags (or accept the defaults).
 */
export interface OpenHostConfig {
  /** TCP port for the WS server; 0 lets the OS pick a free port. */
  readonly port: number;
  /** pid.json slot (production → ~/.traycer/host, else ~/.traycer/host/<env>). */
  readonly environment: string;
  /** Authn service used to verify bearers presented at the open frame. */
  readonly authnBaseUrl: string;
  /**
   * Accept any non-empty bearer without verifying it against authn, mapping
   * every connection to the single local user. This is the DEFAULT: the open
   * host is local-only software (it binds 127.0.0.1 and is reached through
   * the web server's proxy), so no Traycer account is required. Pass
   * `--require-auth` to opt back into verifying bearers against authn.
   */
  readonly insecureNoAuth: boolean;
  /** Local OpenClaw Gateway control plane (WS). */
  readonly openclawGatewayUrl: string;
  /** Optional shared-secret/device token for the OpenClaw Gateway connect. */
  readonly openclawGatewayToken: string | null;
}

export const OPEN_HOST_VERSION = "0.0.0-open";

const DEFAULT_AUTHN_BASE_URL = "https://authn.traycer.ai";
const DEFAULT_OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";

export function parseOpenHostArgs(argv: readonly string[]): OpenHostConfig {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(arg.slice(2), next);
      i += 1;
      continue;
    }
    flags.add(arg.slice(2));
  }
  const port = Number(values.get("port") ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid --port: ${values.get("port")}`);
  }
  return {
    port,
    environment: values.get("environment") ?? "production",
    authnBaseUrl: values.get("authn-url") ?? DEFAULT_AUTHN_BASE_URL,
    // `--insecure-no-auth` (the pre-local-default spelling) stays accepted;
    // it is simply the default now unless `--require-auth` is passed.
    insecureNoAuth: !flags.has("require-auth"),
    openclawGatewayUrl:
      values.get("openclaw-gateway-url") ?? DEFAULT_OPENCLAW_GATEWAY_URL,
    openclawGatewayToken: values.get("openclaw-gateway-token") ?? null,
  };
}
