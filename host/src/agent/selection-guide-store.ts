import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSelectionGuideResponse } from "@traycer/protocol/host/agent/shared";
import { hostHomeDir } from "../pid-file";

/**
 * The global agent selection guide (`agent.selectionGuide.*`): a single
 * markdown file under the host home that Settings edits and agents read at
 * turn start. The closed host layers workspace guides on top; the open host
 * serves the global file only (workspace guides come from the agent's own
 * checkout, which the OpenClaw Gateway reads directly).
 */
const GUIDE_FILENAME = "open-host-selection-guide.md";

const GENERATED_DEFAULT = [
  "# Agent selection guide",
  "",
  "This host runs agents through the local OpenClaw Gateway.",
  "Use the `openclaw` harness for every task; model and tool",
  "selection are owned by the gateway's own configuration.",
  "",
].join("\n");

export class SelectionGuideStore {
  private readonly environment: string;

  constructor(environment: string) {
    this.environment = environment;
  }

  generatedDefault(): string {
    return GENERATED_DEFAULT;
  }

  private guidePath(): string {
    return join(hostHomeDir(this.environment), GUIDE_FILENAME);
  }

  /** Stored content, or null when the user never saved an override. */
  async readStored(): Promise<string | null> {
    try {
      return await readFile(this.guidePath(), "utf8");
    } catch {
      return null;
    }
  }

  /** Effective global content: the stored override or the generated default. */
  async effectiveContent(): Promise<string> {
    return (await this.readStored()) ?? GENERATED_DEFAULT;
  }

  async set(content: string): Promise<void> {
    try {
      await mkdir(hostHomeDir(this.environment), { recursive: true });
      await writeFile(this.guidePath(), content, "utf8");
    } catch {
      // Best-effort persistence.
    }
  }

  async reset(): Promise<void> {
    await rm(this.guidePath(), { force: true }).catch(() => undefined);
  }

  /**
   * `agent.selectionGuide` (the per-agent resolve): the open host layers no
   * workspace guides, so the answer is the global file alone — `not_found`
   * when it is effectively empty.
   */
  async evaluate(): Promise<AgentSelectionGuideResponse> {
    const content = await this.effectiveContent();
    if (content.trim().length === 0) {
      return {
        status: "not_found",
        message: "no selection guide is configured on this host",
      };
    }
    return {
      status: "found",
      sources: [
        {
          kind: "global",
          path: this.guidePath(),
          priority: 0,
          content,
        },
      ],
    };
  }
}
