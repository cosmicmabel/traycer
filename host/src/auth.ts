/**
 * Bearer handling for the open frame.
 *
 * The wire contract (framework/ws-protocol.ts) carries a bearer in every
 * `/rpc` and `/stream` client `open` frame. The host is local-only software
 * with no accounts: any non-empty bearer is accepted and maps to the single
 * local user. Identity here is a formality of the wire contract, not a
 * security boundary - the host binds 127.0.0.1 only, so exposure is governed
 * entirely by whatever fronts it (the web server's `--bind`).
 */
export type BearerVerdict =
  | { readonly kind: "valid"; readonly userId: string }
  | { readonly kind: "invalid" };

export const LOCAL_USER_ID = "local-user";

export class BearerVerifier {
  async verify(token: string): Promise<BearerVerdict> {
    if (token.length === 0) {
      return { kind: "invalid" };
    }
    return { kind: "valid", userId: LOCAL_USER_ID };
  }
}
