import { describe, expect, test } from "bun:test";
import { CliDetector, type VersionProbe } from "../cli-detect";

function probeReturning(answers: Record<string, string | null>): {
  probe: VersionProbe;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    probe: {
      async probe(binary: string): Promise<string | null> {
        calls.push(binary);
        return binary in answers ? answers[binary] : null;
      },
    },
  };
}

describe("CliDetector", () => {
  test("reports available with the version when the binary answers", async () => {
    const { probe } = probeReturning({ claude: "claude 1.2.3" });
    const detector = new CliDetector(probe);
    const detection = await detector.detect("claude", []);
    expect(detection.available).toBe(true);
    expect(detection.binary).toBe("claude");
    expect(detection.version).toBe("claude 1.2.3");
  });

  test("reports unavailable when the binary is not on PATH", async () => {
    const { probe } = probeReturning({});
    const detector = new CliDetector(probe);
    const detection = await detector.detect("codex", []);
    expect(detection.available).toBe(false);
    expect(detection.binary).toBe(null);
  });

  test("prefers a custom path over the default binary", async () => {
    const { probe, calls } = probeReturning({
      "/opt/claude/bin/claude": "claude 9.9.9",
      claude: "claude 1.0.0",
    });
    const detector = new CliDetector(probe);
    const detection = await detector.detect("claude", [
      "/opt/claude/bin/claude",
    ]);
    expect(detection.binary).toBe("/opt/claude/bin/claude");
    expect(detection.version).toBe("claude 9.9.9");
    // The default binary is never probed once the custom path answers.
    expect(calls).toEqual(["/opt/claude/bin/claude"]);
  });

  test("caches the verdict (a second detect does not re-probe)", async () => {
    const { probe, calls } = probeReturning({ grok: "grok 0.1" });
    const detector = new CliDetector(probe);
    await detector.detect("grok", []);
    await detector.detect("grok", []);
    expect(calls).toEqual(["grok"]);
  });
});
