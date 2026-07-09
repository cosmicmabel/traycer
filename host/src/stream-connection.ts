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
 * The open host currently accepts the handshake and heartbeats but has no
 * stream method sessions yet: every `subscribe` is answered with a terminal
 * `fatalError` naming the unimplemented method, which the client surfaces as
 * a stream failure for that surface only (the unary surface is unaffected).
 * `chat.subscribe` backed by the OpenClaw Gateway adapter is the first
 * planned session (see host/README.md roadmap).
 */
export interface StreamConnectionDeps {
  readonly registry: VersionedStreamRpcRegistry;
  readonly manifest: ConnectionManifest;
  readonly verifier: BearerVerifier;
}

export interface StreamSocket {
  send(frame: string): void;
  close(code: number, reason: string): void;
}

const pingFrameSchema = z.object({
  kind: z.literal("ping"),
  hasBinaryPayload: z.literal(false),
});

type Phase = "awaiting-open" | "awaiting-subscribe" | "subscribed" | "done";

export class StreamConnection {
  private readonly deps: StreamConnectionDeps;
  private readonly socket: StreamSocket;
  private phase: Phase = "awaiting-open";

  constructor(deps: StreamConnectionDeps, socket: StreamSocket) {
    this.deps = deps;
    this.socket = socket;
  }

  handleClose(): void {
    this.phase = "done";
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
      // No stream sessions are implemented yet - reject the method
      // terminally so the client does not reconnect-loop against a session
      // that can never exist. (Backoff-worthy failures use retryable:true.)
      this.fatal({
        code: "RPC_ERROR",
        reason: `stream method not implemented in @traycer/open-host: ${subscribe.data.method}`,
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }

    if (this.phase === "subscribed") {
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
