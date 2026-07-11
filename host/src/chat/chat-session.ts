import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeOpenRequestSchema,
  type ChatQueuedItem,
  type ChatQueueState,
  type ChatRunSettings,
  type ChatSubscribeServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  chatSchema,
  type Chat,
  type ChatEvent,
  type Message,
  type UserMessage,
} from "@traycer/protocol/persistence/epic/schemas";
import { hostHomeDir } from "../pid-file";
import type { RuntimeEvent } from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  OpenClawGatewayConnection,
  type OpenClawGatewayOptions,
} from "../openclaw/gateway-client";

/**
 * `chat.subscribe@1.3` stream session backed by the OpenClaw Gateway.
 *
 * Scope (first milestone of the host/README.md roadmap): snapshot on
 * subscribe, `send` → actionAck / messageAccepted / turnStateChanged /
 * blockDelta runtime events / durable eventAppended rows / turn completion,
 * and `stop`. Queueing, approvals, checkpoints, worktrees, and the other
 * owner actions are acknowledged as rejected ("not supported yet") so the
 * GUI's per-action error surface reports them without dropping the stream.
 *
 * Chats are stored in-memory per host process (keyed epicId/chatId, created
 * lazily on first subscribe). The OpenClaw Gateway owns the durable agent
 * session; this session maps its `chat`/`agent` event stream onto the
 * protocol's RuntimeEvent lanes (text deltas + turn lifecycle).
 */
interface ChatKeyState {
  readonly epicId: string;
  readonly chat: Chat;
  runStatus: "idle" | "running" | "stopping";
  activeTurn: ActiveTurnState | null;
  turn: ActiveTurnRun | null;
  queuePaused: boolean;
  readonly queued: Array<{
    readonly item: ChatQueuedItem;
    readonly frame: SendFrame;
  }>;
  readonly emitters: Set<(frame: ChatSubscribeServerFrame) => void>;
  flushTimer: NodeJS.Timeout | null;
}

const FLUSH_DEBOUNCE_MS = 500;

type SendFrame = Extract<
  z.output<typeof chatSubscribeClientFrameSchema>,
  { kind: "send" }
>;

interface ActiveTurnState {
  readonly turnId: string;
  status:
    "starting" | "running" | "stopping" | "completed" | "stopped" | "errored";
  readonly harnessId: ChatRunSettings["harnessId"];
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly agentMode: ChatRunSettings["agentMode"];
  readonly userMessageId: string;
  readonly startedAt: number;
  updatedAt: number;
}

interface ActiveTurnRun {
  readonly connection: OpenClawGatewayConnection;
  stopped: boolean;
}

export class ChatSessionStore {
  private readonly gateway: OpenClawGatewayOptions;
  private readonly environment: string;
  private readonly chats = new Map<string, ChatKeyState>();

  constructor(gateway: OpenClawGatewayOptions, environment: string) {
    this.gateway = gateway;
    this.environment = environment;
  }

  /**
   * Debounced chat-record flush to
   * `~/.traycer/host[/env]/open-host-chats/<epic>__<chat>.json` so
   * transcripts survive host restarts. Best-effort: the in-memory record
   * stays authoritative.
   */
  markDirty(state: ChatKeyState): void {
    if (state.flushTimer !== null) {
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void this.flush(state);
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flush(state: ChatKeyState): Promise<void> {
    try {
      await mkdir(this.blobDir(), { recursive: true });
      await writeFile(
        join(this.blobDir(), blobName(state.epicId, state.chat.id)),
        JSON.stringify(state.chat),
        "utf8",
      );
    } catch {
      // Best-effort persistence.
    }
  }

  private async readPersisted(
    epicId: string,
    chatId: string,
  ): Promise<Chat | null> {
    try {
      const raw = await readFile(
        join(this.blobDir(), blobName(epicId, chatId)),
        "utf8",
      );
      const parsed = chatSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private blobDir(): string {
    return join(hostHomeDir(this.environment), "open-host-chats");
  }

  /**
   * Unary creation path (`epic.create`'s folded chat seed and
   * `epic.createChat`): mints the chat record up front - idempotent on
   * `chatId` - so the subsequent `chat.subscribe` finds it titled. Returns
   * the persisted-shape record for Y.Doc seeding.
   */
  async ensureChat(input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly userId: string;
    readonly title: string;
  }): Promise<Chat> {
    const state = await this.getOrCreate(
      input.epicId,
      input.chatId,
      input.userId,
    );
    if (input.title.length > 0 && state.chat.title.length === 0) {
      state.chat.title = input.title;
      state.chat.updatedAt = Date.now();
      this.markDirty(state);
    }
    return state.chat;
  }

  /** `epic.renameChat`: user-authored title, pinned against regeneration. */
  async renameChat(input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly userId: string;
    readonly title: string;
  }): Promise<Chat> {
    const state = await this.getOrCreate(
      input.epicId,
      input.chatId,
      input.userId,
    );
    state.chat.title = input.title;
    state.chat.isTitleEditedByUser = true;
    state.chat.updatedAt = Date.now();
    this.markDirty(state);
    return state.chat;
  }

  /** `epic.deleteChat`: drops the live state and the persisted blob. */
  async deleteChat(epicId: string, chatId: string): Promise<void> {
    this.chats.delete(`${epicId}/${chatId}`);
    await rm(join(this.blobDir(), blobName(epicId, chatId)), { force: true });
  }

  /** `epic.batchDelete`: drops every chat (live + persisted) of an epic. */
  async deleteEpicChats(epicId: string): Promise<void> {
    for (const key of [...this.chats.keys()]) {
      if (key.startsWith(`${epicId}/`)) {
        this.chats.delete(key);
      }
    }
    const prefix = blobName(epicId, "");
    try {
      const entries = await readdir(this.blobDir());
      for (const entry of entries) {
        if (entry.startsWith(prefix.slice(0, -".json".length))) {
          await rm(join(this.blobDir(), entry), { force: true });
        }
      }
    } catch {
      // Missing blob dir means nothing to delete.
    }
  }

  async subscribe(input: {
    readonly params: unknown;
    readonly userId: string;
    readonly emit: (frame: ChatSubscribeServerFrame) => void;
  }): Promise<ChatSubscription | null> {
    const open = chatSubscribeOpenRequestSchema.safeParse(input.params);
    if (!open.success) {
      return null;
    }
    const state = await this.getOrCreate(
      open.data.epicId,
      open.data.chatId,
      input.userId,
    );
    state.emitters.add(input.emit);
    // The caller emits the initial snapshot once its transport is ready to
    // forward frames (see stream-connection.ts's phase gate).
    return new ChatSubscription(
      this.gateway,
      open.data.epicId,
      open.data.chatId,
      input.userId,
      state,
      input.emit,
      () => {
        this.markDirty(state);
      },
    );
  }

  private async getOrCreate(
    epicId: string,
    chatId: string,
    userId: string,
  ): Promise<ChatKeyState> {
    const key = `${epicId}/${chatId}`;
    const existing = this.chats.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const persisted = await this.readPersisted(epicId, chatId);
    const now = Date.now();
    const created: ChatKeyState = {
      epicId,
      chat: persisted ?? {
        parentId: null,
        id: chatId,
        userId,
        hostId: "open-host",
        title: "",
        createdAt: now,
        updatedAt: now,
        isTitleEditedByUser: false,
        settings: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
        events: [],
      },
      runStatus: "idle",
      activeTurn: null,
      turn: null,
      queuePaused: false,
      queued: [],
      emitters: new Set(),
      flushTimer: null,
    };
    // Two concurrent loads race the disk read; last-write-wins on the map is
    // fine (same persisted bytes), but keep the first-inserted state if one
    // landed while we awaited.
    const raced = this.chats.get(key);
    if (raced !== undefined) {
      return raced;
    }
    this.chats.set(key, created);
    return created;
  }
}

/** Filesystem-safe blob name (epic/chat ids are uuids in practice). */
function blobName(epicId: string, chatId: string): string {
  const sanitize = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${sanitize(epicId)}__${sanitize(chatId)}.json`;
}

export class ChatSubscription {
  private readonly gateway: OpenClawGatewayOptions;
  private readonly epicId: string;
  private readonly chatId: string;
  private readonly userId: string;
  private readonly state: ChatKeyState;
  private readonly emit: (frame: ChatSubscribeServerFrame) => void;
  private readonly persist: () => void;

  constructor(
    gateway: OpenClawGatewayOptions,
    epicId: string,
    chatId: string,
    userId: string,
    state: ChatKeyState,
    emit: (frame: ChatSubscribeServerFrame) => void,
    persist: () => void,
  ) {
    this.gateway = gateway;
    this.epicId = epicId;
    this.chatId = chatId;
    this.userId = userId;
    this.state = state;
    this.emit = emit;
    this.persist = persist;
  }

  dispose(): void {
    this.state.emitters.delete(this.emit);
  }

  emitSnapshot(): void {
    this.emit({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: this.epicId,
      chatId: this.chatId,
      snapshot: {
        chat: this.state.chat,
        access: { role: "owner", ownerUserId: this.userId, canAct: true },
        queue: this.queueWireState(),
        runStatus: this.state.runStatus,
        activeTurn: this.state.activeTurn,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
        turnInProgress: this.state.runStatus === "running",
      },
    });
  }

  async handleFrame(parsed: unknown): Promise<void> {
    const frame = chatSubscribeClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      return;
    }
    const data = frame.data;
    if (data.kind === "ping") {
      this.emit({ kind: "pong", hasBinaryPayload: false });
      return;
    }
    if (data.kind === "send") {
      await this.handleSend(data);
      return;
    }
    if (data.kind === "stop") {
      this.handleStop(data.clientActionId);
      return;
    }
    if (data.kind === "pauseQueue") {
      this.state.queuePaused = true;
      this.ackAccepted(data.clientActionId, data.kind);
      this.broadcastQueue();
      this.appendChatEvent(
        "queue.paused",
        data.clientActionId,
        null,
        null,
        null,
      );
      return;
    }
    if (data.kind === "resumeQueue") {
      this.state.queuePaused = false;
      this.ackAccepted(data.clientActionId, data.kind);
      this.broadcastQueue();
      this.appendChatEvent(
        "queue.resumed",
        data.clientActionId,
        null,
        null,
        null,
      );
      void this.drainQueue();
      return;
    }
    if (data.kind === "queueCancel") {
      const index = this.state.queued.findIndex(
        (entry) => entry.item.queueItemId === data.queueItemId,
      );
      if (index === -1) {
        this.ackRejected(
          data.clientActionId,
          data.kind,
          "queue item not found",
        );
        return;
      }
      const [removed] = this.state.queued.splice(index, 1);
      this.ackAccepted(data.clientActionId, data.kind);
      this.broadcastQueue();
      this.appendChatEvent(
        "queue.cancelled",
        data.clientActionId,
        null,
        removed.item.messageId,
        removed.item.queueItemId,
      );
      return;
    }
    // Every other owner action is acknowledged as rejected so the GUI's
    // per-action error surface reports it without dropping the stream.
    this.emit({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: this.epicId,
      chatId: this.chatId,
      clientActionId: readClientActionId(parsed),
      action: data.kind,
      status: "rejected",
      reason: `chat action not supported by @traycer/open-host yet: ${data.kind}`,
      code: "RPC_ERROR",
      backgroundStopTaskIds: [],
    });
  }

  private async handleSend(frame: SendFrame): Promise<void> {
    if (this.state.runStatus !== "idle" || this.state.queuePaused) {
      // A running turn (or a paused queue) queues the send instead of
      // rejecting it; delivery happens at the next turn boundary.
      const now = Date.now();
      const item = {
        queueItemId: randomUUID(),
        messageId: frame.messageId,
        message: buildUserPayload(frame.sender, frame.content),
        sender: frame.sender,
        settings: frame.settings,
        accountContext: frame.accountContext,
        delivery: "next_turn" as const,
        status: "pending" as const,
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: now,
        updatedAt: now,
      };
      this.state.queued.push({ item, frame });
      this.ackAccepted(frame.clientActionId, "send");
      this.broadcastQueue();
      this.appendChatEvent(
        "queue.added",
        frame.clientActionId,
        null,
        frame.messageId,
        item.queueItemId,
      );
      return;
    }
    await this.deliverSend(frame);
  }

  private async deliverSend(frame: SendFrame): Promise<void> {
    const now = Date.now();
    const userMessage: UserMessage = {
      role: "user",
      messageId: frame.messageId,
      sender: frame.sender,
      message: buildUserPayload(frame.sender, frame.content),
      timestamp: now,
      sessionAnchor: null,
    };
    this.state.chat.messages.push(userMessage);
    this.state.chat.updatedAt = now;
    this.persist();

    this.ackAccepted(frame.clientActionId, "send");
    this.broadcast({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: this.epicId,
      chatId: this.chatId,
      message: userMessage,
    });
    this.appendChatEvent(
      "send.accepted",
      frame.clientActionId,
      null,
      frame.messageId,
      null,
    );

    const turnId = randomUUID();
    this.state.runStatus = "running";
    this.state.activeTurn = {
      turnId,
      status: "starting",
      harnessId: frame.settings.harnessId,
      model: frame.settings.model,
      reasoningEffort: frame.settings.reasoningEffort,
      serviceTier: frame.settings.serviceTier,
      agentMode: frame.settings.agentMode,
      userMessageId: frame.messageId,
      startedAt: now,
      updatedAt: now,
    };
    this.broadcastTurnState();

    await this.runTurn(
      turnId,
      frame.messageId,
      promptTextFromContent(frame.content),
    );
  }

  private async runTurn(
    turnId: string,
    userMessageId: string,
    prompt: string,
  ): Promise<void> {
    const blockId = randomUUID();
    let accumulated = "";
    const emitEvent = (event: RuntimeEvent): void => {
      this.broadcast({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: this.epicId,
        chatId: this.chatId,
        event,
      });
    };
    const tools = new TurnToolTracker(emitEvent);

    try {
      const connection = await OpenClawGatewayConnection.connect(this.gateway);
      this.state.turn = { connection, stopped: false };
      if (this.state.activeTurn !== null) {
        this.state.activeTurn.status = "running";
        this.state.activeTurn.updatedAt = Date.now();
      }
      this.broadcastTurnState();
      emitEvent({
        blockId: turnId,
        timestamp: Date.now(),
        type: "turn.started",
        turnId,
      });
      this.appendChatEvent("turn.started", null, turnId, userMessageId, null);

      const detach = await connection.sendChat({
        sessionKey: `traycer-${this.chatId}`,
        message: prompt,
        onAgentEvent: (event) => {
          if (tools.handle(event)) {
            return;
          }
          const delta = extractTextDelta(event.payload, accumulated);
          if (delta.length > 0) {
            accumulated += delta;
            emitEvent({
              blockId,
              timestamp: Date.now(),
              type: "text.delta",
              delta,
            });
          }
        },
      });
      // The gateway's chat.send resolves when the turn is accepted; give the
      // event stream a short drain window for trailing deltas before
      // finalizing. (A richer lifecycle mapping is tracked in the roadmap.)
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      detach();
      connection.close();
    } catch (cause) {
      this.finishTurn(
        turnId,
        userMessageId,
        blockId,
        accumulated,
        tools.blocks(),
        {
          kind: "errored",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      );
      return;
    }
    if (this.state.turn?.stopped === true) {
      this.finishTurn(
        turnId,
        userMessageId,
        blockId,
        accumulated,
        tools.blocks(),
        {
          kind: "stopped",
        },
      );
      return;
    }
    emitEvent({ blockId, timestamp: Date.now(), type: "text.completed" });
    this.finishTurn(
      turnId,
      userMessageId,
      blockId,
      accumulated,
      tools.blocks(),
      {
        kind: "completed",
      },
    );
  }

  private finishTurn(
    turnId: string,
    userMessageId: string,
    blockId: string,
    text: string,
    toolBlocks: readonly ToolCallBlock[],
    outcome:
      | { readonly kind: "completed" }
      | { readonly kind: "stopped" }
      | { readonly kind: "errored"; readonly message: string },
  ): void {
    const now = Date.now();
    const activeTurn = this.state.activeTurn;
    const assistant: Message = {
      role: "assistant",
      messageId: randomUUID(),
      sender: {
        type: "agent",
        harnessId: "openclaw",
        agentId: this.chatId,
        displayName: "OpenClaw",
        reply: { expectsReply: false },
      },
      blocks: [
        ...toolBlocks,
        ...(text.length > 0 || outcome.kind === "completed"
          ? [
              {
                blockId,
                status:
                  outcome.kind === "errored"
                    ? ("errored" as const)
                    : ("completed" as const),
                timestamp: now,
                type: "text" as const,
                text:
                  text.length > 0
                    ? text
                    : "(the OpenClaw Gateway returned no text for this turn)",
                providerNotice: null,
              },
            ]
          : []),
      ],
      startedAt: activeTurn?.startedAt ?? now,
      timestamp: now,
      turnId,
      usage: null,
      reasoningEffort: activeTurn?.reasoningEffort ?? null,
      serviceTier: activeTurn?.serviceTier ?? null,
    };
    this.state.chat.messages.push(assistant);
    this.state.chat.updatedAt = now;
    this.persist();

    if (outcome.kind === "completed") {
      this.broadcast({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: this.epicId,
        chatId: this.chatId,
        event: {
          blockId: turnId,
          timestamp: now,
          type: "turn.completed",
          turnId,
        },
      });
      this.appendChatEvent("turn.completed", null, turnId, userMessageId, null);
    } else if (outcome.kind === "stopped") {
      this.broadcast({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: this.epicId,
        chatId: this.chatId,
        event: {
          blockId: turnId,
          timestamp: now,
          type: "turn.stopped",
          turnId,
          reason: "stopped by user",
        },
      });
      this.appendChatEvent("turn.stopped", null, turnId, userMessageId, null);
    } else {
      this.broadcast({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: this.epicId,
        chatId: this.chatId,
        notice: {
          code: "OPENCLAW_GATEWAY_ERROR",
          message: outcome.message,
          severity: "error",
          clientActionId: null,
        },
      });
      this.appendChatEvent(
        "turn.interrupted",
        null,
        turnId,
        userMessageId,
        null,
      );
    }

    this.state.turn = null;
    this.state.runStatus = "idle";
    this.state.activeTurn = null;
    this.broadcastTurnState();
    void this.drainQueue();
  }

  private handleStop(clientActionId: string): void {
    if (this.state.runStatus !== "running" || this.state.turn === null) {
      this.emit({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: this.epicId,
        chatId: this.chatId,
        clientActionId,
        action: "stop",
        status: "rejected",
        reason: "no active turn",
        code: "NO_ACTIVE_TURN",
        backgroundStopTaskIds: [],
      });
      return;
    }
    this.state.turn.stopped = true;
    this.state.runStatus = "stopping";
    this.state.turn.connection.close();
    this.ackAccepted(clientActionId, "stop");
    this.broadcastTurnState();
  }

  private queueWireState(): ChatQueueState {
    return {
      status: this.state.queuePaused
        ? "paused"
        : this.state.queued.length > 0
          ? "running"
          : "idle",
      items: this.state.queued.map((entry) => entry.item),
    };
  }

  private broadcastQueue(): void {
    this.broadcast({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: this.epicId,
      chatId: this.chatId,
      queue: this.queueWireState(),
    });
  }

  /**
   * Delivers the next queued send at a turn boundary. Fired (not awaited)
   * from `finishTurn` and `resumeQueue`; each delivery re-enters this drain
   * when its own turn finishes, so the queue empties one turn at a time.
   */
  private async drainQueue(): Promise<void> {
    if (
      this.state.runStatus !== "idle" ||
      this.state.queuePaused ||
      this.state.queued.length === 0
    ) {
      return;
    }
    const entry = this.state.queued.shift();
    if (entry === undefined) {
      return;
    }
    this.broadcastQueue();
    this.appendChatEvent(
      "queue.started",
      null,
      null,
      entry.item.messageId,
      entry.item.queueItemId,
    );
    await this.deliverSend(entry.frame);
  }

  private ackRejected(
    clientActionId: string,
    action: "send" | "stop" | "pauseQueue" | "resumeQueue" | "queueCancel",
    reason: string,
  ): void {
    this.emit({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: this.epicId,
      chatId: this.chatId,
      clientActionId,
      action,
      status: "rejected",
      reason,
      code: "RPC_ERROR",
      backgroundStopTaskIds: [],
    });
  }

  private ackAccepted(
    clientActionId: string,
    action: "send" | "stop" | "pauseQueue" | "resumeQueue" | "queueCancel",
  ): void {
    this.emit({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: this.epicId,
      chatId: this.chatId,
      clientActionId,
      action,
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
  }

  private appendChatEvent(
    type: ChatEvent["type"],
    clientActionId: string | null,
    turnId: string | null,
    messageId: string | null,
    queueItemId: string | null,
  ): void {
    const event: ChatEvent = {
      eventId: randomUUID(),
      type,
      timestamp: Date.now(),
      clientActionId,
      actor: { type: "user", userId: this.userId },
      message: null,
      turnId,
      messageId,
      queueItemId,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: null,
    };
    this.state.chat.events.push(event);
    this.persist();
    this.broadcast({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: this.epicId,
      chatId: this.chatId,
      event,
    });
  }

  private broadcastTurnState(): void {
    this.broadcast({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: this.epicId,
      chatId: this.chatId,
      runStatus: this.state.runStatus,
      activeTurn: this.state.activeTurn,
      turnInProgress: this.state.runStatus === "running",
    });
  }

  private broadcast(frame: ChatSubscribeServerFrame): void {
    for (const emitter of this.state.emitters) {
      emitter(frame);
    }
  }
}

function buildUserPayload(
  sender: UserMessage["sender"],
  content: SendFrame["content"],
): UserMessage["message"] {
  if (sender.type === "agent") {
    return {
      kind: "agent",
      content,
      fromAgentId: sender.agentId,
      senderTitle: sender.displayName,
      senderHarnessId: sender.harnessId,
      reply: sender.reply ?? { expectsReply: false },
    };
  }
  return { kind: "user", content };
}

/** Persisted-shape tool_call content block (all defaulted fields present). */
type ToolCallBlock = Extract<
  Message & { role: "assistant" },
  { role: "assistant" }
>["blocks"][number] & { type: "tool_call" };

/**
 * Maps the OpenClaw Gateway's tool events onto the protocol's `tool_call`
 * RuntimeEvent lane and collects finished blocks for the assistant message.
 *
 * The gateway's event names/payloads vary by channel (`session.tool`,
 * `agent` run events with tool phases); the extractor is deliberately
 * tolerant: any event whose name mentions "tool" with a resolvable tool
 * name is tracked, keyed by the payload's call id when present so
 * concurrent calls don't collide.
 */
export class TurnToolTracker {
  private readonly emitEvent: (event: RuntimeEvent) => void;
  private readonly open = new Map<
    string,
    {
      readonly blockId: string;
      readonly toolName: string;
      readonly startedAt: number;
    }
  >();
  private readonly finished: ToolCallBlock[] = [];

  constructor(emitEvent: (event: RuntimeEvent) => void) {
    this.emitEvent = emitEvent;
  }

  blocks(): readonly ToolCallBlock[] {
    return this.finished;
  }

  /** Returns true when the event was a tool event (consumed). */
  handle(event: {
    readonly event: string;
    readonly payload: unknown;
  }): boolean {
    const tool = extractToolEvent(event.event, event.payload);
    if (tool === null) {
      return false;
    }
    const now = Date.now();
    if (tool.phase === "started") {
      const blockId = randomUUID();
      this.open.set(tool.key, {
        blockId,
        toolName: tool.toolName,
        startedAt: now,
      });
      this.emitEvent({
        blockId,
        timestamp: now,
        type: "tool_call.started",
        toolName: tool.toolName,
        agentMessageSend: null,
        startedAt: now,
      });
      return true;
    }
    const started = this.open.get(tool.key);
    const blockId = started?.blockId ?? randomUUID();
    const startedAt = started?.startedAt ?? now;
    this.open.delete(tool.key);
    if (tool.phase === "errored") {
      this.emitEvent({
        blockId,
        timestamp: now,
        type: "tool_call.errored",
        toolName: tool.toolName,
        error: tool.error ?? "tool call failed",
        terminationReason: "error",
        agentMessageSend: null,
      });
    } else {
      this.emitEvent({
        blockId,
        timestamp: now,
        type: "tool_call.completed",
        toolName: tool.toolName,
        agentMessageSend: null,
      });
    }
    this.finished.push({
      blockId,
      status: tool.phase === "errored" ? "errored" : "completed",
      timestamp: now,
      type: "tool_call",
      toolName: tool.toolName,
      inputSummary: null,
      inputDetail: null,
      taskTodoItems: null,
      error:
        tool.phase === "errored" ? (tool.error ?? "tool call failed") : null,
      agentMessageSend: null,
      progress: null,
      backgroundOutput: null,
      startedAt,
      endedAt: now,
      backgroundTask: false,
      stopped: false,
    });
    return true;
  }
}

interface ExtractedToolEvent {
  readonly key: string;
  readonly toolName: string;
  readonly phase: "started" | "completed" | "errored";
  readonly error: string | null;
}

export function extractToolEvent(
  eventName: string,
  payload: unknown,
): ExtractedToolEvent | null {
  if (!eventName.toLowerCase().includes("tool")) {
    return null;
  }
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const readString = (key: string): string | null => {
    const value = Reflect.get(payload, key);
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const toolName =
    readString("toolName") ?? readString("name") ?? readString("tool");
  if (toolName === null) {
    return null;
  }
  const key =
    readString("callId") ??
    readString("toolCallId") ??
    readString("id") ??
    toolName;
  const phaseRaw = (
    readString("phase") ??
    readString("status") ??
    readString("state") ??
    ""
  ).toLowerCase();
  const error = readString("error");
  let phase: ExtractedToolEvent["phase"];
  if (error !== null || ["error", "errored", "failed"].includes(phaseRaw)) {
    phase = "errored";
  } else if (
    ["end", "ended", "done", "completed", "complete", "ok", "success"].includes(
      phaseRaw,
    ) ||
    Reflect.get(payload, "result") !== undefined
  ) {
    phase = "completed";
  } else {
    phase = "started";
  }
  return { key, toolName, phase, error };
}

/**
 * Best-effort plain-text projection of the send frame's json-content, used
 * as the prompt for the gateway. Rich content (mentions, attachments) is
 * flattened to its text nodes.
 */
export function promptTextFromContent(content: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child);
      }
      return;
    }
    const text = Reflect.get(node, "text");
    if (typeof text === "string") {
      parts.push(text);
    }
    walk(Reflect.get(node, "content"));
  };
  walk(content);
  return parts.join(" ").trim();
}

/**
 * Extracts the NEW text carried by a gateway event. The gateway's `chat.*`
 * events carry cumulative assistant snapshots in `deltaText`; other event
 * families carry plain `text`/`delta` fields. Cumulative payloads are
 * diffed against what has already been emitted.
 */
export function extractTextDelta(
  payload: unknown,
  accumulated: string,
): string {
  if (payload === null || typeof payload !== "object") {
    return "";
  }
  const delta = Reflect.get(payload, "delta");
  if (typeof delta === "string") {
    return delta;
  }
  const deltaText = Reflect.get(payload, "deltaText");
  if (typeof deltaText === "string") {
    return deltaText.startsWith(accumulated)
      ? deltaText.slice(accumulated.length)
      : deltaText;
  }
  const text = Reflect.get(payload, "text");
  if (typeof text === "string") {
    return text.startsWith(accumulated) ? text.slice(accumulated.length) : text;
  }
  return "";
}

function readClientActionId(parsed: unknown): string {
  if (parsed !== null && typeof parsed === "object") {
    const id = Reflect.get(parsed, "clientActionId");
    if (typeof id === "string") {
      return id;
    }
  }
  return "";
}
