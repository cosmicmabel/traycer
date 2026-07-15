import type { CliHarnessId } from "./cli-detect";

/**
 * Runs the OAuth/browser login flow of a vendor CLI as a child process.
 *
 * The vendor CLIs (`claude`, `codex`, `grok`) own their own OAuth: their
 * `login` command opens a browser (or prints a URL) and completes the flow
 * through their own loopback callback, persisting the session in the CLI's
 * own config. The host just launches that command, surfaces the URL it
 * prints so the GUI can offer an "open" button, and waits for the child to
 * exit — the exit IS the "did login finish?" signal
 * (`providers.startLogin` → `providers.awaitLogin`).
 *
 * Because the login relies on the CLI's loopback callback, it works when the
 * browser and the host are the same machine (the default local setup). For a
 * remote host, paste a token/key instead (the provider's `token.vars`).
 */

/** OAuth-login shape per CLI harness, surfaced as `loginCapability`. */
export interface CliLoginConfig {
  /** Args for the CLI's browser-OAuth login (null when unsupported). */
  readonly oauthArgs: readonly string[] | null;
  /** Env vars the user can paste a key/token into instead of OAuth. */
  readonly tokenVars: readonly string[];
}

export const CLI_LOGIN: Record<CliHarnessId, CliLoginConfig> = {
  // `claude setup-token` runs the OAuth browser flow and stores a long-lived
  // token — the headless-friendly entry point (plain `claude` also prompts).
  claude: {
    oauthArgs: ["setup-token"],
    tokenVars: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  },
  // `codex login` signs in with a ChatGPT account via the browser.
  codex: { oauthArgs: ["login"], tokenVars: ["OPENAI_API_KEY"] },
  // Grok's login subcommand (best-effort; adjust if your CLI differs).
  grok: { oauthArgs: ["login"], tokenVars: ["XAI_API_KEY"] },
};

/** Seam so tests drive a fake login child instead of a real spawn. */
export interface LoginProcess {
  /** Resolves with the first URL the child prints, or null if none appears. */
  urlPromise(): Promise<string | null>;
  /** Resolves with the child's exit code when it finishes. */
  exited(): Promise<number>;
  kill(): void;
}

export interface LoginSpawner {
  spawn(cmd: readonly string[]): LoginProcess;
}

const URL_PATTERN = /https?:\/\/[^\s"']+/;

export const bunLoginSpawner: LoginSpawner = {
  spawn(cmd: readonly string[]): LoginProcess {
    const proc = Bun.spawn([...cmd], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    let resolveUrl: (url: string | null) => void = () => undefined;
    const url = new Promise<string | null>((resolve) => {
      resolveUrl = resolve;
    });
    // Scan both streams for the first printed URL; resolve null once the
    // process ends without printing one.
    const scan = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const match = buffer.match(URL_PATTERN);
        if (match !== null) {
          resolveUrl(match[0]);
          return;
        }
      }
    };
    void Promise.all([scan(proc.stdout), scan(proc.stderr)]).then(() =>
      resolveUrl(null),
    );
    return {
      urlPromise: () => url,
      exited: () => proc.exited,
      kill: () => proc.kill(),
    };
  },
};

interface InFlightLogin {
  readonly process: LoginProcess;
  readonly done: Promise<number>;
}

/**
 * Tracks one in-flight login child per provider. `start` launches it and
 * returns the printed URL; `await` blocks until it exits; `cancel` kills it.
 */
export class LoginProcessStore {
  private readonly spawner: LoginSpawner;
  private readonly inFlight = new Map<string, InFlightLogin>();

  constructor(spawner: LoginSpawner) {
    this.spawner = spawner;
  }

  hasInFlight(providerId: string): boolean {
    return this.inFlight.has(providerId);
  }

  /**
   * Launches `<binary> <oauthArgs…>` for the provider and resolves with the
   * first URL it prints (racing a short deadline so the GUI is not left
   * hanging when a CLI opens the browser without printing a URL).
   */
  async start(
    providerId: string,
    binary: string,
    oauthArgs: readonly string[],
    urlDeadlineMs: number,
  ): Promise<string | null> {
    this.cancel(providerId);
    const process = this.spawner.spawn([binary, ...oauthArgs]);
    const done = process.exited();
    this.inFlight.set(providerId, { process, done });
    // Clean up the slot when the child finishes on its own.
    void done.finally(() => {
      if (this.inFlight.get(providerId)?.process === process) {
        this.inFlight.delete(providerId);
      }
    });
    const deadline = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), urlDeadlineMs),
    );
    return Promise.race([process.urlPromise(), deadline]);
  }

  /** Awaits the in-flight login child's exit; null if none is running. */
  async await(providerId: string): Promise<number | null> {
    const entry = this.inFlight.get(providerId);
    if (entry === undefined) {
      return null;
    }
    return entry.done;
  }

  cancel(providerId: string): boolean {
    const entry = this.inFlight.get(providerId);
    if (entry === undefined) {
      return false;
    }
    entry.process.kill();
    this.inFlight.delete(providerId);
    return true;
  }
}
