/**
 * Import surface for `clients/*` workspaces: same-package relatives,
 * `@cic/*`, `@cic/protocol/*` (and TS path aliases to those),
 * or third-party packages. Blocks other monorepo scopes such as
 * `packages/common` (`@cicai/*`) and non-protocol `@cic/*` paths.
 *
 * Wire via `@typescript-eslint/no-restricted-imports`:
 * `["error", cicClientsImportBoundaryRestrictions]`.
 */
import { protocolBoundaryRestrictions } from "./protocol-boundary-rules.mjs";

export const cicClientsImportBoundaryRestrictions = {
  patterns: [
    ...protocolBoundaryRestrictions.patterns,
    {
      group: ["@cicai/**"],
      message:
        "Client packages must not import `@cicai/*` (for example packages/common). " +
        "Use `@cic/protocol/*` or `@cic/*` instead.",
    },
    {
      // The whole product lives in one `@cic` scope now; clients may reach
      // the protocol, the shared client library, and the GUI library, but
      // nothing else that might appear under the scope later (e.g. the host
      // server package - clients talk to it over the wire, never by import).
      group: [
        "@cic/**",
        "!@cic/protocol",
        "!@cic/protocol/**",
        "!@cic/shared",
        "!@cic/shared/**",
        "!@cic/gui-app",
        "!@cic/gui-app/**",
      ],
      message:
        "Client packages may only import `@cic/protocol/*`, `@cic/shared/*`, " +
        "or `@cic/gui-app` from the `@cic` scope.",
    },
  ],
};
