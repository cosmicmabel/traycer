import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  worktreeBindingOwnerKindSchema,
  worktreeBindingSchema,
  type WorktreeBinding,
  type WorktreeBindingOwnerKind,
} from "@traycer/protocol/host/worktree-schemas";
import { hostHomeDir } from "../pid-file";

/**
 * Per-owner worktree bindings (the closed host keeps these in SQLite; the
 * open host uses a JSON file next to its other stores). A binding row is
 * keyed by (epicId, ownerKind, ownerId) and stores the exact wire
 * `WorktreeBinding` shape so reads re-parse against the canonical contracts
 * without remapping. Rows never leave this host — cloud collaborators must
 * not see another machine's local paths.
 */
export interface BindingOwnerKey {
  readonly epicId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly ownerId: string;
}

const bindingRowSchema = z.object({
  epicId: z.string(),
  ownerKind: worktreeBindingOwnerKindSchema,
  ownerId: z.string(),
  binding: worktreeBindingSchema,
  updatedAt: z.number(),
});
export type BindingRow = z.infer<typeof bindingRowSchema>;

const bindingFileSchema = z.object({ rows: z.array(bindingRowSchema) });

function sameOwner(row: BindingRow, key: BindingOwnerKey): boolean {
  return (
    row.epicId === key.epicId &&
    row.ownerKind === key.ownerKind &&
    row.ownerId === key.ownerId
  );
}

export class BindingStore {
  private readonly environment: string;
  private rows: BindingRow[] | null = null;

  constructor(environment: string) {
    this.environment = environment;
  }

  async get(key: BindingOwnerKey): Promise<BindingRow | null> {
    const rows = await this.loadAll();
    return rows.find((row) => sameOwner(row, key)) ?? null;
  }

  async set(key: BindingOwnerKey, binding: WorktreeBinding): Promise<void> {
    const rows = await this.loadAll();
    const next = rows.filter((row) => !sameOwner(row, key));
    next.push({ ...key, binding, updatedAt: Date.now() });
    this.rows = next;
    await this.save();
  }

  async listForEpic(epicId: string): Promise<readonly BindingRow[]> {
    const rows = await this.loadAll();
    return rows.filter((row) => row.epicId === epicId);
  }

  async listAll(): Promise<readonly BindingRow[]> {
    return this.loadAll();
  }

  /**
   * Applies an in-place update to one owner's binding and persists. The
   * updater receives the current binding (empty when no row exists) and
   * returns the next one; the row's `updatedAt` is restamped.
   */
  async update(
    key: BindingOwnerKey,
    updater: (binding: WorktreeBinding) => WorktreeBinding,
  ): Promise<WorktreeBinding> {
    const current = (await this.get(key))?.binding ?? { entries: [] };
    const next = updater(current);
    await this.set(key, next);
    return next;
  }

  /**
   * Disk-truth check the `worktree.getBinding` response carries: bound
   * effective directories (`worktreePath ?? workspacePath`) missing on disk.
   */
  async missingWorktreePaths(
    binding: WorktreeBinding | null,
  ): Promise<string[]> {
    if (binding === null) {
      return [];
    }
    const missing: string[] = [];
    for (const entry of binding.entries) {
      const effective = entry.worktreePath ?? entry.workspacePath;
      const info = await stat(effective).catch(() => null);
      if (info === null || !info.isDirectory()) {
        missing.push(entry.workspacePath);
      }
    }
    return missing;
  }

  private async loadAll(): Promise<BindingRow[]> {
    if (this.rows !== null) {
      return this.rows;
    }
    let parsed: BindingRow[] = [];
    try {
      const raw = await readFile(this.filePath(), "utf8");
      const file = bindingFileSchema.safeParse(JSON.parse(raw));
      if (file.success) {
        parsed = file.data.rows;
      }
    } catch {
      // Missing/corrupt store starts empty.
    }
    this.rows = parsed;
    return parsed;
  }

  private async save(): Promise<void> {
    if (this.rows === null) {
      return;
    }
    try {
      await mkdir(hostHomeDir(this.environment), { recursive: true });
      await writeFile(
        this.filePath(),
        JSON.stringify({ rows: this.rows }),
        "utf8",
      );
    } catch {
      // Best-effort persistence; the in-memory rows stay authoritative.
    }
  }

  private filePath(): string {
    return join(
      hostHomeDir(this.environment),
      "open-host-worktree-bindings.json",
    );
  }
}
