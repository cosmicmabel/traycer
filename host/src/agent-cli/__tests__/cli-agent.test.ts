import { describe, expect, test } from "bun:test";
import { buildCommand, runCliTurn, type ProcessRunner } from "../cli-agent";

/** A fake runner that replays scripted stdout chunks and an exit code. */
function fakeRunner(script: {
  chunks: readonly string[];
  exitCode?: number;
  stderr?: string;
  capture?: (cmd: readonly string[], stdin: string | null) => void;
}): ProcessRunner {
  return {
    async run(input) {
      script.capture?.(input.cmd, input.stdin);
      for (const chunk of script.chunks) {
        input.onStdoutChunk(chunk);
      }
      return { exitCode: script.exitCode ?? 0, stderr: script.stderr ?? "" };
    },
  };
}

describe("buildCommand", () => {
  test("claude runs print mode with the prompt on stdin and resume flag", () => {
    const spawn = buildCommand({
      harnessId: "claude",
      binary: "claude",
      prompt: "hello",
      cwd: "/tmp",
      model: "claude-opus-4-8",
      resumeSessionId: "sess-1",
    });
    expect(spawn.cmd).toContain("--output-format");
    expect(spawn.cmd).toContain("stream-json");
    expect(spawn.cmd).toContain("--resume");
    expect(spawn.cmd).toContain("sess-1");
    expect(spawn.stdin).toBe("hello");
    expect(spawn.parse).toBe("claude-json");
  });

  test("codex runs exec --json with the prompt as an argument", () => {
    const spawn = buildCommand({
      harnessId: "codex",
      binary: "codex",
      prompt: "do a thing",
      cwd: "/tmp",
      model: "gpt-5-codex",
      resumeSessionId: null,
    });
    expect(spawn.cmd).toContain("exec");
    expect(spawn.cmd).toContain("--json");
    expect(spawn.cmd).toContain("do a thing");
    expect(spawn.stdin).toBe(null);
  });

  test("grok reads the prompt on stdin as plain text", () => {
    const spawn = buildCommand({
      harnessId: "grok",
      binary: "grok",
      prompt: "hey grok",
      cwd: "/tmp",
      model: "grok-4",
      resumeSessionId: null,
    });
    expect(spawn.stdin).toBe("hey grok");
    expect(spawn.parse).toBe("text");
  });
});

describe("runCliTurn", () => {
  const base = {
    binary: "x",
    prompt: "p",
    cwd: "/tmp",
    model: "m",
    resumeSessionId: null,
  } as const;

  test("streams Claude stream-json text deltas and captures the session id", async () => {
    const deltas: string[] = [];
    const runner = fakeRunner({
      chunks: [
        '{"type":"system","session_id":"abc"}\n',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n',
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n',
      ],
    });
    const result = await runCliTurn(
      { ...base, harnessId: "claude" },
      { onTextDelta: (d) => deltas.push(d) },
      runner,
      new AbortController().signal,
    );
    expect(deltas.join("")).toBe("Hello");
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.sessionId).toBe("abc");
    }
  });

  test("handles partial JSON lines split across chunks", async () => {
    const deltas: string[] = [];
    const runner = fakeRunner({
      chunks: ['{"delta":{"type":"text_del', 'ta","text":"split"}}\n'],
    });
    await runCliTurn(
      { ...base, harnessId: "claude" },
      { onTextDelta: (d) => deltas.push(d) },
      runner,
      new AbortController().signal,
    );
    expect(deltas.join("")).toBe("split");
  });

  test("codex message content blocks stream as text", async () => {
    const deltas: string[] = [];
    const runner = fakeRunner({
      chunks: [
        '{"type":"item","message":{"content":[{"type":"text","text":"answer"}]}}\n',
      ],
    });
    await runCliTurn(
      { ...base, harnessId: "codex" },
      { onTextDelta: (d) => deltas.push(d) },
      runner,
      new AbortController().signal,
    );
    expect(deltas.join("")).toBe("answer");
  });

  test("grok plain text streams straight through", async () => {
    const deltas: string[] = [];
    const runner = fakeRunner({ chunks: ["plain ", "text"] });
    await runCliTurn(
      { ...base, harnessId: "grok" },
      { onTextDelta: (d) => deltas.push(d) },
      runner,
      new AbortController().signal,
    );
    expect(deltas.join("")).toBe("plain text");
  });

  test("a non-zero exit surfaces stderr as an errored turn", async () => {
    const runner = fakeRunner({
      chunks: [],
      exitCode: 1,
      stderr: "not logged in",
    });
    const result = await runCliTurn(
      { ...base, harnessId: "grok" },
      { onTextDelta: () => undefined },
      runner,
      new AbortController().signal,
    );
    expect(result.kind).toBe("errored");
    if (result.kind === "errored") {
      expect(result.message).toBe("not logged in");
    }
  });
});
