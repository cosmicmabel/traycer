import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  clientStreamOpenFrameSchema,
  clientStreamSubscribeFrameSchema,
  type HostStreamOpenAckFrame,
  type HostStreamFatalErrorFrame,
} from "@traycer/protocol/framework/stream-ws-protocol";
import type {
  ConnectionManifest,
  FatalErrorDetails,
} from "@traycer/protocol/framework/ws-protocol";
import { checkStreamCompatibility } from "@traycer/protocol/framework/stream-compat";
import { z } from "zod";
import type { BearerVerifier } from "./auth";
import type { ChatSessionStore, ChatSubscription } from "./chat/chat-session";
import type { EpicStore, EpicSubscription } from "./epic/epic-store";
import type {
  GitStatusBroadcaster,
  GitStatusSubscription,
} from "./git/git-status-broadcaster";

/**
 * Per-socket state machine for the streaming `/stream` endpoint.
 *
 * Wire contract (framework/stream-ws-protocol.ts + ws-stream-client.ts):
 *   client `open { token, manifest }`
 *     → host `openAck { manifest, capabilities }` (or `fatalError` + close)
 *   client `subscribe { method, schemaVersion, params }`
 *     → per-method application frames until either side closes;
 *   client pings `{ kind:"ping", hasBinaryPayload:false }` every 25s and the
 *   host MUST answer `{ kind:"pong", hasBinaryPayload:false }` or the client
 *   drops the socket after 60s (close 4004).
 *
 * Implemented sessions: `chat.subscribe` (backed by the OpenClaw Gateway,
 * see chat/chat-session.ts) and `epic.subscribe` (Y.Doc relay + persistence,
 * see epic/epic-store.ts). Every other `subscribe` is answered with a
 * terminal `fatalError` naming the unimplemented method, which the client
 * surfaces as a stream failure for that surface only (the unary surface is
 * unaffected).
 *
 * Binary pairing (framework/stream-ws-protocol.ts): a binary WS frame is the
 * payload of the immediately-preceding text envelope whose
 * `hasBinaryPayload` is `true`; in-order delivery is the correlation.
 */
export interface StreamConnectionDeps {
  readonly registry: VersionedStreamRpcRegistry;
  readonly manifest: ConnectionManifest;
  readonly verifier: BearerVerifier;
  readonly chats: ChatSessionStore;
  readonly epics: EpicStore;
  readonly gitStatus: GitStatusBroadcaster;
}

export interface StreamSocket {
  send(frame: string): void;
  sendBinary(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
}

const pingFrameSchema = z.object({
  kind: z.literal("ping"),
  hasBinaryPayload: z.literal(false),
});

/** Minimal envelope read used only to detect binary-paired client frames. */
const binaryEnvelopeSchema = z
  .object({
    kind: z.string(),
    hasBinaryPayload: z.boolean(),
  })
  .loose();

type Phase = "awaiting-open" | "awaiting-subscribe" | "subscribed" | "done";

export class StreamConnection {
  private readonly deps: StreamConnectionDeps;
  private readonly socket: StreamSocket;
  private phase: Phase = "awaiting-open";
  private userId: string | null = null;
  private chatSubscription: ChatSubscription | null = null;
  private epicSubscription: EpicSubscription | null = null;
  private gitStatusSubscription: GitStatusSubscription | null = null;
  /** Text envelope awaiting its paired binary frame (in-order correlation). */
  private pendingBinaryEnvelope: unknown | null = null;

  constructor(deps: StreamConnectionDeps, socket: StreamSocket) {
    this.deps = deps;
    this.socket = socket;
  }

  handleClose(): void {
    this.phase = "done";
    this.chatSubscription?.dispose();
    this.chatSubscription = null;
    this.epicSubscription?.dispose();
    this.epicSubscription = null;
    this.gitStatusSubscription?.dispose();
    this.gitStatusSubscription = null;
  }

  async handleBinary(bytes: Uint8Array): Promise<void> {
    if (this.phase !== "subscribed" || this.pendingBinaryEnvelope === null) {
      this.socket.close(4003, "unexpected-binary-frame");
      this.phase = "done";
      return;
    }
    const envelope = this.pendingBinaryEnvelope;
    this.pendingBinaryEnvelope = null;
    if (this.epicSubscription !== null) {
      await this.epicSubscription.handleFrame(envelope, bytes);
    }
  }

  async handleMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.socket.close(4002, "malformed-text-frame");
      this.phase = "done";
      return;
    }

    if (this.phase === "awaiting-open") {
      const open = clientStreamOpenFrameSchema.safeParse(parsed);
      if (!open.success) {
        this.socket.close(4002, "malformed-text-frame");
        this.phase = "done";
        return;
      }
      await this.handleOpen(open.data.token, open.data.manifest);
      return;
    }

    if (this.phase === "awaiting-subscribe") {
      const subscribe = clientStreamSubscribeFrameSchema.safeParse(parsed);
      if (!subscribe.success) {
        this.socket.close(4002, "malformed-text-frame");
        this.phase = "done";
        return;
      }
      if (subscribe.data.method === "epic.subscribe" && this.userId !== null) {
        const subscription = await this.deps.epics.subscribe({
          params: subscribe.data.params,
          emit: (frame, binary) => {
            if (this.phase !== "subscribed") {
              return;
            }
            this.socket.send(JSON.stringify(frame));
            if (binary !== null) {
              this.socket.sendBinary(binary);
            }
          },
        });
        if (subscription === null) {
          this.fatal({
            code: "RPC_ERROR",
            reason: "epic.subscribe params did not parse",
            incompatibleMethods: null,
            upgradeGuidance: null,
          });
          return;
        }
        this.phase = "subscribed";
        this.epicSubscription = subscription;
        subscription.emitSnapshot();
        return;
      }
      if (subscribe.data.method === "chat.subscribe" && this.userId !== null) {
        const subscription = await this.deps.chats.subscribe({
          params: subscribe.data.params,
          userId: this.userId,
          emit: (frame) => {
            if (this.phase === "subscribed") {
              this.socket.send(JSON.stringify(frame));
            }
          },
        });
        if (subscription === null) {
          this.fatal({
            code: "CHAT_INVALID",
            reason: "chat.subscribe params did not parse",
            incompatibleMethods: null,
            upgradeGuidance: null,
          });
          return;
        }
        // Flip to subscribed BEFORE the snapshot so the emit gate above
        // lets the initial frame through.
        this.phase = "subscribed";
        this.chatSubscription = subscription;
        subscription.emitSnapshot();
        return;
      }
      if (
        subscribe.data.method === "git.subscribeStatus" &&
        this.userId !== null
      ) {
        // Unlike chat/epic (separate emitSnapshot call), the broadcaster
        // emits the initial snapshot INSIDE subscribe(), so the phase must
        // flip first or the emit gate below would drop it. A parse failure
        // still terminates cleanly: fatal() moves the phase to done.
        this.phase = "subscribed";
        const subscription = await this.deps.gitStatus.subscribe({
          params: subscribe.data.params,
          emit: (event) => {
            if (this.phase === "subscribed") {
              this.socket.send(JSON.stringify(event));
            }
          },
        });
        if (subscription === null) {
          this.fatal({
            code: "RPC_ERROR",
            reason: "git.subscribeStatus params did not parse",
            incompatibleMethods: null,
            upgradeGuidance: null,
          });
          return;
        }
        this.gitStatusSubscription = subscription;
        return;
      }
      // Remaining stream methods are rejected terminally so the client does
      // not reconnect-loop against a session that can never exist.
      // (Backoff-worthy failures use retryable:true.)
      this.fatal({
        code: "RPC_ERROR",
        reason: `stream method not implemented in @traycer/open-host: ${subscribe.data.method}`,
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }

    if (this.phase === "subscribed") {
      if (this.chatSubscription !== null) {
        await this.chatSubscription.handleFrame(parsed);
        return;
      }
      if (this.epicSubscription !== null) {
        const envelope = binaryEnvelopeSchema.safeParse(parsed);
        if (envelope.success && envelope.data.hasBinaryPayload) {
          // Hold the envelope until its paired binary frame arrives.
          this.pendingBinaryEnvelope = parsed;
          return;
        }
        await this.epicSubscription.handleFrame(parsed, null);
        return;
      }
      const ping = pingFrameSchema.safeParse(parsed);
      if (ping.success) {
        this.socket.send(
          JSON.stringify({ kind: "pong", hasBinaryPayload: false }),
        );
      }
    }
  }

  private async handleOpen(
    token: string,
    clientManifest: ConnectionManifest,
  ): Promise<void> {
    const verdict = await this.deps.verifier.verify(token);
    if (verdict.kind === "invalid") {
      this.fatal({
        code: "UNAUTHORIZED",
        reason: "bearer token was rejected",
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }
    if (verdict.kind === "unavailable") {
      this.fatal({
        code: "UNAUTHORIZED",
        reason: "bearer verification is temporarily unavailable",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      });
      return;
    }

    const compat = checkStreamCompatibility(
      this.deps.registry,
      this.deps.manifest,
      clientManifest,
      "host",
    );
    if (!compat.ok) {
      this.fatal(compat.details);
      return;
    }

    this.userId = verdict.userId;
    this.phase = "awaiting-subscribe";
    const ack: HostStreamOpenAckFrame = {
      kind: "openAck",
      manifest: this.deps.manifest,
      capabilities: [],
    };
    this.socket.send(JSON.stringify(ack));
  }

  private fatal(details: FatalErrorDetails): void {
    this.phase = "done";
    const frame: HostStreamFatalErrorFrame = { kind: "fatalError", details };
    this.socket.send(JSON.stringify(frame));
    this.socket.close(1000, details.code);
  }
}
