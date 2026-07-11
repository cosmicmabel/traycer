import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  epicLightWithPermissionSchema,
  type EpicLightWithPermission,
} from "@traycer/protocol/host/epic/unary-schemas";
import { hostHomeDir } from "../pid-file";

/**
 * Local task index behind `epic.listTasks` / `epic.create`.
 *
 * The closed host proxies these to the CloudData task API; the open host has
 * no cloud, so the index is a JSON file next to the epic Y.Doc blobs. Rows
 * are stored in the exact `epicLightWithPermissionSchema` wire shape so
 * list/create responses re-parse against the canonical contracts without
 * remapping. `permission`/`roomInfo` stay `null` (single-user local host, no
 * Tiptap cloud room) and repo/workspace associations start empty - the GUI
 * renders such rows without chips.
 */
const indexFileSchema = z.object({
  tasks: z.array(epicLightWithPermissionSchema),
});

export class TaskIndex {
  private readonly environment: string;
  private tasks: EpicLightWithPermission[] | null = null;

  constructor(environment: string) {
    this.environment = environment;
  }

  async list(limit: number): Promise<readonly EpicLightWithPermission[]> {
    const tasks = await this.loadAll();
    return [...tasks]
      .sort((a, b) => (b.light?.updatedAt ?? 0) - (a.light?.updatedAt ?? 0))
      .slice(0, Math.max(0, limit));
  }

  /**
   * `epic.updateTitle`-style partial update. Returns false when the epic is
   * not in the index (mirrors the cloud resolver's `{updated:false}`).
   */
  async applyDelta(delta: {
    readonly id: string;
    readonly updatedAt: number;
    readonly title?: string;
    readonly ticketCount?: number;
    readonly specCount?: number;
    readonly storyCount?: number;
    readonly reviewCount?: number;
    readonly status?: string;
    readonly initialUserPrompt?: string;
  }): Promise<boolean> {
    const tasks = await this.loadAll();
    const row = tasks.find((task) => task.light?.id === delta.id);
    if (row === undefined || row.light === null || row.light === undefined) {
      return false;
    }
    row.light.updatedAt = delta.updatedAt;
    if (delta.title !== undefined) row.light.title = delta.title;
    if (delta.ticketCount !== undefined)
      row.light.ticketCount = delta.ticketCount;
    if (delta.specCount !== undefined) row.light.specCount = delta.specCount;
    if (delta.storyCount !== undefined) row.light.storyCount = delta.storyCount;
    if (delta.reviewCount !== undefined)
      row.light.reviewCount = delta.reviewCount;
    if (delta.status !== undefined) row.light.status = delta.status;
    if (delta.initialUserPrompt !== undefined) {
      row.light.initialUserPrompt = delta.initialUserPrompt;
    }
    await this.save();
    return true;
  }

  async upsert(row: EpicLightWithPermission): Promise<void> {
    const tasks = await this.loadAll();
    const id = row.light?.id;
    const next = tasks.filter((task) => task.light?.id !== id);
    next.push(row);
    this.tasks = next;
    await this.save();
  }

  /** `epic.batchDelete` per-id removal; false when the id was not indexed. */
  async remove(epicId: string): Promise<boolean> {
    const tasks = await this.loadAll();
    const next = tasks.filter((task) => task.light?.id !== epicId);
    if (next.length === tasks.length) {
      return false;
    }
    this.tasks = next;
    await this.save();
    return true;
  }

  private async loadAll(): Promise<EpicLightWithPermission[]> {
    if (this.tasks !== null) {
      return this.tasks;
    }
    let parsed: EpicLightWithPermission[] = [];
    try {
      const raw = await readFile(this.filePath(), "utf8");
      const file = indexFileSchema.safeParse(JSON.parse(raw));
      if (file.success) {
        parsed = file.data.tasks;
      }
    } catch {
      // Missing/corrupt index starts empty; creates re-populate it.
    }
    this.tasks = parsed;
    return parsed;
  }

  private async save(): Promise<void> {
    if (this.tasks === null) {
      return;
    }
    try {
      await mkdir(join(hostHomeDir(this.environment)), { recursive: true });
      await writeFile(
        this.filePath(),
        JSON.stringify({ tasks: this.tasks }),
        "utf8",
      );
    } catch {
      // Best-effort persistence; the in-memory index stays authoritative.
    }
  }

  private filePath(): string {
    return join(hostHomeDir(this.environment), "open-host-tasks.json");
  }
}
