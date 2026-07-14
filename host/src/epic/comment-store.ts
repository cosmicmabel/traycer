import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  commentThreadWireSchema,
  LatestEpicArtifactKindSchema,
  type CommentThreadWire,
} from "@cic/protocol/host/epic/unary-schemas";
import { hostHomeDir } from "../pid-file";

/**
 * Artifact comment threads (`epic.*CommentThread*` / `epic.*Comment*`).
 *
 * The closed host proxies these to the cloud collaboration service; the
 * open host keeps them in a local JSON store keyed by
 * (epicId, artifactType, artifactId), in the exact `commentThreadWireSchema`
 * shape so list responses re-parse against the canonical contract. Missing
 * threads/comments throw — the dispatcher surfaces them as structured RPC
 * errors (the mutating responses have no failure channel of their own).
 */
const threadRowSchema = z.object({
  epicId: z.string(),
  artifactType: LatestEpicArtifactKindSchema,
  artifactId: z.string(),
  thread: commentThreadWireSchema,
});
type ThreadRow = z.infer<typeof threadRowSchema>;

const commentFileSchema = z.object({ rows: z.array(threadRowSchema) });

export interface ArtifactRef {
  readonly epicId: string;
  readonly artifactType: ThreadRow["artifactType"];
  readonly artifactId: string;
}

function sameArtifact(row: ThreadRow, ref: ArtifactRef): boolean {
  return (
    row.epicId === ref.epicId &&
    row.artifactType === ref.artifactType &&
    row.artifactId === ref.artifactId
  );
}

export class CommentStore {
  private readonly environment: string;
  private rows: ThreadRow[] | null = null;

  constructor(environment: string) {
    this.environment = environment;
  }

  async list(ref: ArtifactRef): Promise<CommentThreadWire[]> {
    const rows = await this.loadAll();
    return rows
      .filter((row) => sameArtifact(row, ref))
      .map((row) => row.thread)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async createThread(input: {
    readonly ref: ArtifactRef;
    readonly userId: string;
    readonly content: unknown;
    readonly quotedText: string;
  }): Promise<string> {
    const rows = await this.loadAll();
    const now = Date.now();
    const thread: CommentThreadWire = commentThreadWireSchema.parse({
      threadId: randomUUID(),
      resolved: false,
      createdAt: now,
      comments: [
        {
          commentId: randomUUID(),
          content: input.content,
          createdAt: now,
          updatedAt: null,
          author: { userId: input.userId, fallbackHandle: null },
        },
      ],
      data: {
        createdByUserId: input.userId,
        createdByHandle: null,
        quotedText: input.quotedText,
      },
    });
    rows.push({ ...input.ref, thread });
    await this.save();
    return thread.threadId;
  }

  async reply(input: {
    readonly ref: ArtifactRef;
    readonly threadId: string;
    readonly userId: string;
    readonly content: unknown;
  }): Promise<void> {
    const thread = await this.requireThread(input.ref, input.threadId);
    const now = Date.now();
    thread.comments.push(
      commentThreadWireSchema.shape.comments.element.parse({
        commentId: randomUUID(),
        content: input.content,
        createdAt: now,
        updatedAt: null,
        author: { userId: input.userId, fallbackHandle: null },
      }),
    );
    await this.save();
  }

  async editComment(input: {
    readonly ref: ArtifactRef;
    readonly threadId: string;
    readonly commentId: string;
    readonly content: unknown;
  }): Promise<void> {
    const thread = await this.requireThread(input.ref, input.threadId);
    const comment = thread.comments.find(
      (candidate) => candidate.commentId === input.commentId,
    );
    if (comment === undefined) {
      throw new Error(`comment not found: ${input.commentId}`);
    }
    comment.content =
      commentThreadWireSchema.shape.comments.element.shape.content.parse(
        input.content,
      );
    comment.updatedAt = Date.now();
    await this.save();
  }

  async deleteComment(input: {
    readonly ref: ArtifactRef;
    readonly threadId: string;
    readonly commentId: string;
  }): Promise<void> {
    const thread = await this.requireThread(input.ref, input.threadId);
    const next = thread.comments.filter(
      (candidate) => candidate.commentId !== input.commentId,
    );
    if (next.length === thread.comments.length) {
      throw new Error(`comment not found: ${input.commentId}`);
    }
    thread.comments = next;
    if (thread.comments.length === 0) {
      // Deleting the last comment removes the thread, matching the cloud
      // behavior the GUI expects (no empty-thread rows).
      await this.deleteThread(input.ref, input.threadId);
      return;
    }
    await this.save();
  }

  async setResolved(
    ref: ArtifactRef,
    threadId: string,
    resolved: boolean,
  ): Promise<void> {
    const thread = await this.requireThread(ref, threadId);
    thread.resolved = resolved;
    await this.save();
  }

  async deleteThread(ref: ArtifactRef, threadId: string): Promise<void> {
    const rows = await this.loadAll();
    const next = rows.filter(
      (row) => !(sameArtifact(row, ref) && row.thread.threadId === threadId),
    );
    if (next.length === rows.length) {
      throw new Error(`comment thread not found: ${threadId}`);
    }
    this.rows = next;
    await this.save();
  }

  private async requireThread(
    ref: ArtifactRef,
    threadId: string,
  ): Promise<CommentThreadWire> {
    const rows = await this.loadAll();
    const row = rows.find(
      (candidate) =>
        sameArtifact(candidate, ref) && candidate.thread.threadId === threadId,
    );
    if (row === undefined) {
      throw new Error(`comment thread not found: ${threadId}`);
    }
    return row.thread;
  }

  private async loadAll(): Promise<ThreadRow[]> {
    if (this.rows !== null) {
      return this.rows;
    }
    let parsed: ThreadRow[] = [];
    try {
      const raw = await readFile(this.filePath(), "utf8");
      const file = commentFileSchema.safeParse(JSON.parse(raw));
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
    return join(hostHomeDir(this.environment), "open-host-comments.json");
  }
}
