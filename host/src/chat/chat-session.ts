import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeOpenRequestSchema,
  type ChatRunSettings,
  type ChatSubscribeServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  Chat,
  ChatEvent,
  Message,
  UserMessage,
} from "@traycer/protocol/persistence/epic/schemas";
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
  readonly chat: Chat;
  runStatus: "idle" | "running" | "stopping";
  activeTurn: ActiveTurnState | null;
  turn: ActiveTurnRun | null;
  readonly emitters: Set<(frame: ChatSubscribeServerFrame) => void>;
}

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
  private readonly chats = new Map<string, ChatKeyState>();

  constructor(gateway: OpenClawGatewayOptions) {
    this.gateway = gateway;
  }

  subscribe(input: {
    readonly params: unknown;
    readonly userId: string;
    readonly emit: (frame: ChatSubscribeServerFrame) => void;
  }): ChatSubscription | null {
    const open = chatSubscribeOpenRequestSchema.safeParse(input.params);
    if (!open.success) {
      return null;
    }
    const state = this.getOrCreate(
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
    );
  }

  private getOrCreate(
    epicId: string,
    chatId: string,
    userId: string,
  ): ChatKeyState {
    const key = `${epicId}/${chatId}`;
    const existing = this.chats.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const now = Date.now();
    const created: ChatKeyState = {
      chat: {
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
      emitters: new Set(),
    };
    this.chats.set(key, created);
    return created;
  }
}

export class ChatSubscription {
  private readonly gateway: OpenClawGatewayOptions;
  private readonly epicId: string;
  private readonly chatId: string;
  private readonly userId: string;
  private readonly state: ChatKeyState;
  private readonly emit: (frame: ChatSubscribeServerFrame) => void;

  constructor(
    gateway: OpenClawGatewayOptions,
    epicId: string,
    chatId: string,
    userId: string,
    state: ChatKeyState,
    emit: (frame: ChatSubscribeServerFrame) => void,
  ) {
    this.gateway = gateway;
    this.epicId = epicId;
    this.chatId = chatId;
    this.userId = userId;
    this.state = state;
    this.emit = emit;
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
        queue: { status: "idle", items: [] },
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
    if (this.state.runStatus !== "idle") {
      this.emit({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: this.epicId,
        chatId: this.chatId,
        clientActionId: frame.clientActionId,
        action: "send",
        status: "rejected",
        reason: "a turn is already running (queueing is not supported yet)",
        code: "RPC_ERROR",
        backgroundStopTaskIds: [],
      });
      return;
    }

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
      this.appendChatEvent("turn.started", null, turnId, userMessageId);

      const detach = await connection.sendChat({
        sessionKey: `traycer-${this.chatId}`,
        message: prompt,
        onAgentEvent: (event) => {
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
      this.finishTurn(turnId, userMessageId, blockId, accumulated, {
        kind: "errored",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (this.state.turn?.stopped === true) {
      this.finishTurn(turnId, userMessageId, blockId, accumulated, {
        kind: "stopped",
      });
      return;
    }
    emitEvent({ blockId, timestamp: Date.now(), type: "text.completed" });
    this.finishTurn(turnId, userMessageId, blockId, accumulated, {
      kind: "completed",
    });
  }

  private finishTurn(
    turnId: string,
    userMessageId: string,
    blockId: string,
    text: string,
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
      blocks:
        text.length > 0 || outcome.kind === "completed"
          ? [
              {
                blockId,
                status: outcome.kind === "errored" ? "errored" : "completed",
                timestamp: now,
                type: "text",
                text:
                  text.length > 0
                    ? text
                    : "(the OpenClaw Gateway returned no text for this turn)",
                providerNotice: null,
              },
            ]
          : [],
      startedAt: activeTurn?.startedAt ?? now,
      timestamp: now,
      turnId,
      usage: null,
      reasoningEffort: activeTurn?.reasoningEffort ?? null,
      serviceTier: activeTurn?.serviceTier ?? null,
    };
    this.state.chat.messages.push(assistant);
    this.state.chat.updatedAt = now;

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
      this.appendChatEvent("turn.completed", null, turnId, userMessageId);
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
      this.appendChatEvent("turn.stopped", null, turnId, userMessageId);
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
      this.appendChatEvent("turn.interrupted", null, turnId, userMessageId);
    }

    this.state.turn = null;
    this.state.runStatus = "idle";
    this.state.activeTurn = null;
    this.broadcastTurnState();
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

  private ackAccepted(clientActionId: string, action: "send" | "stop"): void {
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
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: null,
    };
    this.state.chat.events.push(event);
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
