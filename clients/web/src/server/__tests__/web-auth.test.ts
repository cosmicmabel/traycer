import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  WebAuthStore,
  clearedSessionCookie,
  sessionCookie,
  sessionTokenFromRequest,
  type PasswordHasher,
} from "../web-auth";

// Reversible fake so the store logic runs under vitest's node runtime
// (production uses Bun.password argon2id via `bunPasswordHasher`).
const fakeHasher: PasswordHasher = {
  hash: async (password) => `hashed:${password}`,
  verify: async (password, hash) => hash === `hashed:${password}`,
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cic-web-auth-"));
  path = join(dir, "web-auth.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WebAuthStore", () => {
  it("starts with no password and rejects logins until setup", async () => {
    const store = new WebAuthStore(path, fakeHasher);
    expect(await store.passwordSet()).toBe(false);
    expect((await store.login("whatever-long")).kind).toBe("invalid");
  });

  it("setup creates the password once and mints a working session", async () => {
    const store = new WebAuthStore(path, fakeHasher);
    const result = await store.setup("a-strong-password");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(await store.verifySession(result.token)).toBe(true);
    expect((await store.setup("another-password")).kind).toBe("already-set");
  });

  it("rejects passwords below the minimum length", async () => {
    const store = new WebAuthStore(path, fakeHasher);
    const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    expect((await store.setup(short)).kind).toBe("too-short");
    expect(await store.passwordSet()).toBe(false);
  });

  it("login verifies the password and survives a store reload", async () => {
    const store = new WebAuthStore(path, fakeHasher);
    await store.setup("a-strong-password");

    const reloaded = new WebAuthStore(path, fakeHasher);
    expect((await reloaded.login("wrong-password!")).kind).toBe("invalid");
    const ok = await reloaded.login("a-strong-password");
    expect(ok.kind).toBe("ok");
    if (ok.kind !== "ok") throw new Error("unreachable");

    // Sessions persist to disk: a THIRD store instance accepts the token.
    const third = new WebAuthStore(path, fakeHasher);
    expect(await third.verifySession(ok.token)).toBe(true);
  });

  it("locks out after repeated failures", async () => {
    const store = new WebAuthStore(path, fakeHasher);
    await store.setup("a-strong-password");
    let locked = false;
    for (let i = 0; i < 6; i += 1) {
      const result = await store.login("wrong-password!");
      if (result.kind === "locked") {
        locked = true;
        break;
      }
    }
    expect(locked).toBe(true);
    // While locked, even the RIGHT password is refused.
    expect((await store.login("a-strong-password")).kind).toBe("locked");
  });

  it("logout invalidates the session", async () => {
    const store = new WebAuthStore(path, fakeHasher);
    const result = await store.setup("a-strong-password");
    if (result.kind !== "ok") throw new Error("setup failed");
    await store.logout(result.token);
    expect(await store.verifySession(result.token)).toBe(false);
  });

  it("stores only what the hasher returns, never the raw password", async () => {
    // Opaque fake for this test: the persisted file must contain nothing
    // derived from the password beyond the hasher's output.
    const opaqueHasher: PasswordHasher = {
      hash: async () => "opaque-digest",
      verify: async () => true,
    };
    const store = new WebAuthStore(path, opaqueHasher);
    await store.setup("a-strong-password");
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("a-strong-password");
    expect(raw).toContain("opaque-digest");
  });
});

describe("cookie helpers", () => {
  it("round-trips the session token through the Cookie header", () => {
    const setCookie = sessionCookie("tok123");
    expect(setCookie).toContain("HttpOnly");
    const request = new Request("http://localhost/", {
      headers: { cookie: "other=1; cic_session=tok123; more=2" },
    });
    expect(sessionTokenFromRequest(request)).toBe("tok123");
  });

  it("clears with Max-Age=0", () => {
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });

  it("returns null when the cookie is absent", () => {
    const request = new Request("http://localhost/", {
      headers: { cookie: "other=1" },
    });
    expect(sessionTokenFromRequest(request)).toBe(null);
  });
});
