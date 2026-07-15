import type { CliHarnessId } from "../providers/cli-detect";

/**
 * Drives one agent turn by spawning a vendor CLI and streaming its output
 * back as text deltas.
 *
 * Each harness runs in a non-interactive "print" mode and emits either
 * newline-delimited JSON (Claude Code / Codex) or plain text (Grok). We map
 * whatever text the agent produces onto the same `onTextDelta` the OpenClaw
 * path uses, so the chat session is agnostic to which agent answered.
 *
 * NOTE on flags: the exact non-interactive flags and JSON envelopes differ
 * per CLI and across their versions. The command builders below encode the
 * documented shapes at time of writing and are deliberately isolated here
 * (one `buildCommand` switch) so they are trivial to adjust for a given CLI
 * version without touching the streaming machinery. Auth is each CLI's own
 * concern — the host never sees the vendor credentials.
 */

export interface CliAgentSpawn {
  readonly cmd: readonly string[];
  /** Prompt delivered on stdin when the CLI reads it there (else null). */
  readonly stdin: string | null;
  /** How to interpret stdout. */
  readonly parse: "claude-json" | "codex-json" | "text";
}

export interface CliTurnInput {
  readonly harnessId: CliHarnessId;
  readonly binary: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly model: string;
  /**
   * Prior CLI session id for this chat, when the harness supports resuming a
   * conversation. Null on the first turn.
   */
  readonly resumeSessionId: string | null;
}

export interface CliTurnCallbacks {
  onTextDelta(delta: string): void;
}

export type CliTurnResult =
  | { readonly kind: "completed"; readonly sessionId: string | null }
  | { readonly kind: "errored"; readonly message: string };

/** Seam so tests drive fake CLIs instead of real spawns. */
export interface ProcessRunner {
  run(input: {
    readonly cmd: readonly string[];
    readonly cwd: string;
    readonly stdin: string | null;
    readonly onStdoutChunk: (chunk: string) => void;
    readonly signal: AbortSignal;
  }): Promise<{ readonly exitCode: number; readonly stderr: string }>;
}

export const bunProcessRunner: ProcessRunner = {
  async run(input) {
    const proc = Bun.spawn([...input.cmd], {
      cwd: input.cwd,
      stdin: input.stdin === null ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (input.stdin !== null && proc.stdin !== undefined) {
      proc.stdin.write(input.stdin);
      await proc.stdin.end();
    }
    const onAbort = (): void => proc.kill();
    input.signal.addEventListener("abort", onAbort, { once: true });

    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    // Stream stdout incrementally so text appears as the agent produces it.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      input.onStdoutChunk(decoder.decode(value, { stream: true }));
    }
    const exitCode = await proc.exited;
    input.signal.removeEventListener("abort", onAbort);
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  },
};

export function buildCommand(input: CliTurnInput): CliAgentSpawn {
  switch (input.harnessId) {
    case "claude": {
      // Claude Code print mode streams JSON events; --resume continues a
      // prior session. The prompt goes on stdin so it needs no escaping.
      const cmd = [
        input.binary,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        input.model,
      ];
      if (input.resumeSessionId !== null) {
        cmd.push("--resume", input.resumeSessionId);
      }
      return { cmd, stdin: input.prompt, parse: "claude-json" };
    }
    case "codex": {
      // Codex exec is the non-interactive entrypoint; --json streams events.
      const cmd = [
        input.binary,
        "exec",
        "--json",
        "--model",
        input.model,
        input.prompt,
      ];
      return { cmd, stdin: null, parse: "codex-json" };
    }
    case "grok": {
      // Grok CLI non-interactive: prompt on stdin, plain-text answer on
      // stdout. (No documented streaming JSON envelope at time of writing.)
      const cmd = [input.binary, "--model", input.model];
      return { cmd, stdin: input.prompt, parse: "text" };
    }
  }
}

/**
 * Runs a turn to completion, invoking `onTextDelta` as text streams in.
 * Returns the CLI session id (when the harness reports one) so the next turn
 * can resume the same conversation.
 */
export async function runCliTurn(
  input: CliTurnInput,
  callbacks: CliTurnCallbacks,
  runner: ProcessRunner,
  signal: AbortSignal,
): Promise<CliTurnResult> {
  const spawn = buildCommand(input);
  const parser = createStreamParser(spawn.parse, callbacks.onTextDelta);
  let result: { readonly exitCode: number; readonly stderr: string };
  try {
    result = await runner.run({
      cmd: spawn.cmd,
      cwd: input.cwd,
      stdin: spawn.stdin,
      onStdoutChunk: (chunk) => parser.push(chunk),
      signal,
    });
  } catch (cause) {
    return {
      kind: "errored",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  parser.flush();
  if (result.exitCode !== 0 && !signal.aborted) {
    const detail = result.stderr.trim();
    return {
      kind: "errored",
      message:
        detail.length > 0
          ? detail
          : `${input.harnessId} CLI exited with code ${result.exitCode}`,
    };
  }
  return { kind: "completed", sessionId: parser.sessionId() };
}

// ─── Stream parsers ─────────────────────────────────────────────────────────

interface StreamParser {
  push(chunk: string): void;
  flush(): void;
  sessionId(): string | null;
}

function createStreamParser(
  mode: CliAgentSpawn["parse"],
  onTextDelta: (delta: string) => void,
): StreamParser {
  if (mode === "text") {
    return {
      push: (chunk) => {
        if (chunk.length > 0) {
          onTextDelta(chunk);
        }
      },
      flush: () => undefined,
      sessionId: () => null,
    };
  }
  return createJsonLineParser(mode, onTextDelta);
}

/**
 * Newline-delimited-JSON parser shared by Claude Code and Codex. Buffers a
 * partial trailing line across chunks; each complete line is a JSON object
 * whose text-bearing shape is mapped by `extractLineText`.
 */
function createJsonLineParser(
  mode: "claude-json" | "codex-json",
  onTextDelta: (delta: string) => void,
): StreamParser {
  let buffer = "";
  let session: string | null = null;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      // Not JSON (a stray log line) - surface it as text rather than drop it.
      onTextDelta(trimmed);
      return;
    }
    const sessionId = extractSessionId(value);
    if (sessionId !== null) {
      session = sessionId;
    }
    const text = extractLineText(mode, value);
    if (text.length > 0) {
      onTextDelta(text);
    }
  };

  return {
    push: (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush: () => {
      if (buffer.length > 0) {
        handleLine(buffer);
        buffer = "";
      }
    },
    sessionId: () => session,
  };
}

function extractSessionId(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = record.session_id;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  return null;
}

/**
 * Pulls the assistant's text out of one CLI JSON event. Both Claude Code and
 * Codex emit variations of "message with content blocks" and "delta" events;
 * we read the common shapes and ignore everything else (tool calls, usage,
 * lifecycle) so partial-support never crashes a turn.
 */
function extractLineText(
  mode: "claude-json" | "codex-json",
  value: unknown,
): string {
  if (value === null || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;

  // Claude Code stream-json: {type:"content_block_delta", delta:{type:"text_delta", text}}
  const delta = record.delta;
  if (delta !== null && typeof delta === "object") {
    const deltaText = (delta as Record<string, unknown>).text;
    if (typeof deltaText === "string") {
      return deltaText;
    }
  }

  // Codex --json and Claude assistant messages: {..., message:{content:[{type:"text", text}]}}
  const message = record.message;
  if (message !== null && typeof message === "object") {
    const text = textFromContentArray(
      (message as Record<string, unknown>).content,
    );
    if (text.length > 0) {
      return text;
    }
  }

  // Codex sometimes emits {type:"item.completed"/"agent_message", text|content}
  if (mode === "codex-json") {
    const text = record.text ?? record.content ?? record.message;
    if (typeof text === "string") {
      return text;
    }
  }

  return "";
}

function textFromContentArray(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (block === null || typeof block !== "object") {
        return "";
      }
      const record = block as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
}
