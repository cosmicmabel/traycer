import type {
  ISecureStorage,
  ITokenStore,
  StoredAuthTokens,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * Browser-storage credential persistence for the web shell.
 *
 * Backed by `localStorage`, so tokens are stored in PLAINTEXT scoped to the
 * serving origin. That is an accepted trade-off for the same-machine/LAN
 * deployment this shell targets (the serve process itself is an
 * unauthenticated door to the host on the same network) - anyone who can
 * read this origin's localStorage already has the page. Desktop backs the
 * same contracts with the OS keychain.
 */
const TOKEN_STORE_KEY = "traycer.web.tokens";
const SECURE_STORAGE_PREFIX = "traycer.web.secure:";

export class BrowserTokenStore implements ITokenStore {
  async get(): Promise<StoredAuthTokens | null> {
    const raw = window.localStorage.getItem(TOKEN_STORE_KEY);
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.token !== "string" ||
      typeof record.refreshToken !== "string"
    ) {
      return null;
    }
    return { token: record.token, refreshToken: record.refreshToken };
  }

  async set(tokens: StoredAuthTokens): Promise<void> {
    window.localStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({
        token: tokens.token,
        refreshToken: tokens.refreshToken,
      }),
    );
  }

  async delete(): Promise<void> {
    window.localStorage.removeItem(TOKEN_STORE_KEY);
  }
}

export class BrowserSecureStorage implements ISecureStorage {
  async get(key: string): Promise<string | null> {
    return window.localStorage.getItem(`${SECURE_STORAGE_PREFIX}${key}`);
  }

  async set(key: string, value: string): Promise<void> {
    window.localStorage.setItem(`${SECURE_STORAGE_PREFIX}${key}`, value);
  }

  async delete(key: string): Promise<void> {
    window.localStorage.removeItem(`${SECURE_STORAGE_PREFIX}${key}`);
  }
}
