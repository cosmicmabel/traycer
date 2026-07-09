/**
 * Bearer verification for the open frame.
 *
 * The wire contract (framework/ws-protocol.ts) authenticates every `/rpc`
 * and `/stream` connection with the bearer in the client `open` frame; the
 * host derives identity from the token. The open host verifies the bearer
 * against the authn service's `GET /api/v3/user` (the same endpoint the
 * shared `auth-validation.ts` helpers hit) and caches verdicts briefly so a
 * chatty GUI does not turn every RPC into an authn round trip.
 *
 * Failure semantics the clients expect (see ws-rpc-client / ws-stream-client):
 *  - invalid credential  → fatalError code "UNAUTHORIZED" (client revalidates)
 *  - transient authn outage → fatalError "UNAUTHORIZED" + retryable: true
 *    (client backs off and re-dials without credential recovery)
 */
export type BearerVerdict =
  | { readonly kind: "valid"; readonly userId: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

interface CacheEntry {
  readonly verdict: BearerVerdict;
  readonly expiresAt: number;
}

const VALID_CACHE_TTL_MS = 5 * 60_000;
const INVALID_CACHE_TTL_MS = 30_000;
const AUTHN_TIMEOUT_MS = 10_000;

export class BearerVerifier {
  private readonly authnBaseUrl: string;
  private readonly insecureNoAuth: boolean;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(authnBaseUrl: string, insecureNoAuth: boolean) {
    this.authnBaseUrl = authnBaseUrl;
    this.insecureNoAuth = insecureNoAuth;
  }

  async verify(token: string): Promise<BearerVerdict> {
    if (token.length === 0) {
      return { kind: "invalid" };
    }
    if (this.insecureNoAuth) {
      return { kind: "valid", userId: "insecure-local-user" };
    }
    const cached = this.cache.get(token);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.verdict;
    }
    const verdict = await this.fetchVerdict(token);
    // Never cache "unavailable": the next attempt should retry authn.
    if (verdict.kind !== "unavailable") {
      this.cache.set(token, {
        verdict,
        expiresAt:
          Date.now() +
          (verdict.kind === "valid"
            ? VALID_CACHE_TTL_MS
            : INVALID_CACHE_TTL_MS),
      });
    }
    return verdict;
  }

  private async fetchVerdict(token: string): Promise<BearerVerdict> {
    const base = this.authnBaseUrl.endsWith("/")
      ? this.authnBaseUrl
      : `${this.authnBaseUrl}/`;
    let response: Response;
    try {
      response = await fetch(new URL("api/v3/user", base), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(AUTHN_TIMEOUT_MS),
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: "invalid" };
    }
    if (!response.ok) {
      return { kind: "unavailable" };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "unavailable" };
    }
    const userId = readUserId(body);
    return userId === null
      ? { kind: "unavailable" }
      : { kind: "valid", userId };
  }
}

function readUserId(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const direct = Reflect.get(body, "id");
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const user = Reflect.get(body, "user");
  if (user !== null && typeof user === "object") {
    const nested = Reflect.get(user, "id");
    if (typeof nested === "string" && nested.length > 0) {
      return nested;
    }
  }
  return null;
}
