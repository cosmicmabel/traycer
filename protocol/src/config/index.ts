/**
 * `@cic/protocol/config` - the single source of truth for the on-disk
 * `~/.cic/cli/config.json` store, shared by the CLI and the host.
 *
 * Intentionally NOT re-exported from `@cic/protocol`'s root `index.ts`:
 * `./store` pulls `node:fs`, and only Node consumers (CLI, host) import
 * it - keeping it subpath-only stops browser bundles (gui-app) from ever
 * resolving filesystem APIs.
 */
export * from "./schema";
export * from "./log-level";
export * from "./paths";
export * from "./store";
