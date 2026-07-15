import packageJson from "../../package.json";

/**
 * The running CIC app version, `v`-prefixed. Prefers the build-time
 * `VITE_APP_VERSION` (stamped at release) and falls back to the gui-app
 * package.json version in dev. Shared by the onboarding footer and the
 * Settings version line so both always agree.
 */
export function appVersionLabel(): string {
  const envVersion = import.meta.env.VITE_APP_VERSION;
  const raw =
    typeof envVersion === "string" && envVersion.length > 0
      ? envVersion
      : packageJson.version;
  return raw.startsWith("v") ? raw : `v${raw}`;
}
