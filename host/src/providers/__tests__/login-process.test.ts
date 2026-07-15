import { describe, expect, test } from "bun:test";
import {
  LoginProcessStore,
  type LoginProcess,
  type LoginSpawner,
} from "../login-process";

/** A fake login child with a controllable URL and exit. */
function fakeProcess(opts: {
  url: string | null;
  exitCode?: number;
  resolveExitNow?: boolean;
}): {
  process: LoginProcess;
  finish: (code: number) => void;
  killed: () => boolean;
} {
  let resolveExit: (code: number) => void = () => undefined;
  let wasKilled = false;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  if (opts.resolveExitNow) {
    resolveExit(opts.exitCode ?? 0);
  }
  return {
    killed: () => wasKilled,
    finish: (code) => resolveExit(code),
    process: {
      urlPromise: async () => opts.url,
      exited: () => exited,
      kill: () => {
        wasKilled = true;
        resolveExit(opts.exitCode ?? 143);
      },
    },
  };
}

function spawnerReturning(process: LoginProcess): {
  spawner: LoginSpawner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    spawner: {
      spawn(cmd) {
        calls.push([...cmd]);
        return process;
      },
    },
  };
}

describe("LoginProcessStore", () => {
  test("start spawns the CLI login command and returns the printed URL", async () => {
    const { process } = fakeProcess({ url: "https://auth.example/login?x=1" });
    const { spawner, calls } = spawnerReturning(process);
    const store = new LoginProcessStore(spawner);

    const url = await store.start("codex", "codex", ["login"], 1000);
    expect(url).toBe("https://auth.example/login?x=1");
    expect(calls).toEqual([["codex", "login"]]);
    expect(store.hasInFlight("codex")).toBe(true);
  });

  test("start resolves null (not hang) when no URL appears before the deadline", async () => {
    const never = new Promise<string | null>(() => undefined);
    const { spawner } = spawnerReturning({
      urlPromise: () => never,
      exited: () => new Promise<number>(() => undefined),
      kill: () => undefined,
    });
    const store = new LoginProcessStore(spawner);
    const url = await store.start("claude", "claude", ["setup-token"], 20);
    expect(url).toBe(null);
  });

  test("await blocks until the login child exits, then reports the code", async () => {
    const fake = fakeProcess({ url: null });
    const { spawner } = spawnerReturning(fake.process);
    const store = new LoginProcessStore(spawner);
    await store.start("codex", "codex", ["login"], 10);

    const awaited = store.await("codex");
    fake.finish(0);
    expect(await awaited).toBe(0);
    // The slot is freed once the child exits.
    expect(store.hasInFlight("codex")).toBe(false);
  });

  test("await returns null when no login is in flight", async () => {
    const store = new LoginProcessStore(
      spawnerReturning(fakeProcess({ url: null }).process).spawner,
    );
    expect(await store.await("grok")).toBe(null);
  });

  test("cancel kills the in-flight child", async () => {
    const fake = fakeProcess({ url: null });
    const { spawner } = spawnerReturning(fake.process);
    const store = new LoginProcessStore(spawner);
    await store.start("codex", "codex", ["login"], 10);
    expect(store.cancel("codex")).toBe(true);
    expect(fake.killed()).toBe(true);
    expect(store.hasInFlight("codex")).toBe(false);
    expect(store.cancel("codex")).toBe(false);
  });
});
