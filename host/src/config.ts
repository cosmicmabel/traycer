/**
 * Runtime configuration for the host server. Flat and flag-driven: it is
 * self-hosted, local-only software - operators pass flags (or accept the
 * defaults). There are no accounts and no external services.
 */
export interface OpenHostConfig {
  /** TCP port for the WS server; 0 lets the OS pick a free port. */
  readonly port: number;
  /** pid.json slot (production → the host home, else <host home>/<env>). */
  readonly environment: string;
  /** Local OpenClaw Gateway control plane (WS). */
  readonly openclawGatewayUrl: string;
  /** Optional shared-secret/device token for the OpenClaw Gateway connect. */
  readonly openclawGatewayToken: string | null;
}

export const OPEN_HOST_VERSION = "0.0.0-open";

const DEFAULT_OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";

export function parseOpenHostArgs(argv: readonly string[]): OpenHostConfig {
  const values = new Map<string, string>();
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
    }
  }
  const port = Number(values.get("port") ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid --port: ${values.get("port")}`);
  }
  return {
    port,
    environment: values.get("environment") ?? "production",
    openclawGatewayUrl:
      values.get("openclaw-gateway-url") ?? DEFAULT_OPENCLAW_GATEWAY_URL,
    openclawGatewayToken: values.get("openclaw-gateway-token") ?? null,
  };
}
