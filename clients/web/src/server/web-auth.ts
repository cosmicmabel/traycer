import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Local password gate for the web server.
 *
 * CIC has no accounts and no auth service; this is a single machine-local
 * password protecting the serve port (the door to the host proxy). The
 * password is created on first login, hashed with argon2id, and stored -
 * together with the active browser sessions - in one JSON file under the
 * CIC home. Deleting that file resets the password (next visitor sets a
 * new one), which is the right recovery story for single-user local
 * software: anyone who can delete the file already owns the machine.
 *
 * Sessions are random 256-bit tokens delivered as an HttpOnly cookie; the
 * browser attaches the cookie to every request INCLUDING WebSocket
 * upgrades, which is what lets the `/host/rpc`/`/host/stream` proxy be
 * gated without touching the wire protocol.
 */

export interface WebAuthStatus {
  readonly authRequired: boolean;
  readonly passwordSet: boolean;
  readonly authenticated: boolean;
}

/**
 * Hashing seam: `Bun.password` (argon2id) in production; tests inject a
 * fake so the store logic stays runnable under vitest's node runtime.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export const bunPasswordHasher: PasswordHasher = {
  hash: (password) => Bun.password.hash(password, { algorithm: "argon2id" }),
  verify: (password, hash) => Bun.password.verify(password, hash),
};

interface SessionRecord {
  readonly token: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface AuthFileState {
  passwordHash: string | null;
  sessions: SessionRecord[];
}

export const MIN_PASSWORD_LENGTH = 8;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
const MAX_SESSIONS = 32;
/** After this many consecutive failures, logins pause for LOCKOUT_MS. */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 30_000;

export function webAuthPath(environment: string): string {
  const home = join(homedir(), ".cic");
  return environment === "production"
    ? join(home, "web-auth.json")
    : join(home, "web-auth", `${environment}.json`);
}

export type LoginResult =
  | { readonly kind: "ok"; readonly token: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "locked"; readonly retryAfterMs: number };

export type SetupResult =
  | { readonly kind: "ok"; readonly token: string }
  | { readonly kind: "already-set" }
  | { readonly kind: "too-short" };

export class WebAuthStore {
  private readonly path: string;
  private readonly hasher: PasswordHasher;
  private state: AuthFileState | null = null;
  private consecutiveFailures = 0;
  private lockedUntil = 0;

  constructor(path: string, hasher: PasswordHasher) {
    this.path = path;
    this.hasher = hasher;
  }

  async passwordSet(): Promise<boolean> {
    const state = await this.load();
    return state.passwordHash !== null;
  }

  /** Creates the password (first login). Rejected once one exists. */
  async setup(password: string): Promise<SetupResult> {
    const state = await this.load();
    if (state.passwordHash !== null) {
      return { kind: "already-set" };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { kind: "too-short" };
    }
    state.passwordHash = await this.hasher.hash(password);
    const token = this.mintSession(state);
    await this.persist(state);
    return { kind: "ok", token };
  }

  async login(password: string): Promise<LoginResult> {
    const state = await this.load();
    if (state.passwordHash === null) {
      return { kind: "invalid" };
    }
    const now = Date.now();
    if (now < this.lockedUntil) {
      return { kind: "locked", retryAfterMs: this.lockedUntil - now };
    }
    const valid = await this.hasher.verify(password, state.passwordHash);
    if (!valid) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= LOCKOUT_THRESHOLD) {
        this.lockedUntil = now + LOCKOUT_MS;
        this.consecutiveFailures = 0;
        return { kind: "locked", retryAfterMs: LOCKOUT_MS };
      }
      return { kind: "invalid" };
    }
    this.consecutiveFailures = 0;
    const token = this.mintSession(state);
    await this.persist(state);
    return { kind: "ok", token };
  }

  async verifySession(token: string | null): Promise<boolean> {
    if (token === null || token.length === 0) {
      return false;
    }
    const state = await this.load();
    const now = Date.now();
    const session = state.sessions.find((s) => s.token === token);
    return session !== undefined && session.expiresAt > now;
  }

  async logout(token: string | null): Promise<void> {
    if (token === null) {
      return;
    }
    const state = await this.load();
    const before = state.sessions.length;
    state.sessions = state.sessions.filter((s) => s.token !== token);
    if (state.sessions.length !== before) {
      await this.persist(state);
    }
  }

  private mintSession(state: AuthFileState): string {
    const now = Date.now();
    const token = randomBytes(32).toString("base64url");
    state.sessions = state.sessions
      .filter((s) => s.expiresAt > now)
      .slice(-(MAX_SESSIONS - 1));
    state.sessions.push({
      token,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    return token;
  }

  private async load(): Promise<AuthFileState> {
    if (this.state !== null) {
      return this.state;
    }
    let parsed: unknown = null;
    try {
      const raw = await readFile(this.path, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    this.state = readAuthFileState(parsed);
    return this.state;
  }

  private async persist(state: AuthFileState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
  }
}

function readAuthFileState(parsed: unknown): AuthFileState {
  if (parsed === null || typeof parsed !== "object") {
    return { passwordHash: null, sessions: [] };
  }
  const record = parsed as Record<string, unknown>;
  const passwordHash =
    typeof record.passwordHash === "string" ? record.passwordHash : null;
  const sessions = Array.isArray(record.sessions)
    ? record.sessions.filter(isSessionRecord)
    : [];
  return { passwordHash, sessions };
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.expiresAt === "number"
  );
}

// ─── Cookie helpers ─────────────────────────────────────────────────────────

export const SESSION_COOKIE = "cic_session";

export function sessionTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * `Secure` is intentionally absent: the serve process speaks plain HTTP
 * (127.0.0.1 or a trusted LAN); an operator terminating TLS in front should
 * add their own auth there too. HttpOnly keeps the token out of page JS.
 */
export function sessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
