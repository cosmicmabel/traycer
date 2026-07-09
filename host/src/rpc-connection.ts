import {
  clientFrameSchema,
  type ConnectionManifest,
  type FatalErrorDetails,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { check as checkCompatibility } from "@traycer/protocol/framework/compatibility-checker";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { BearerVerifier } from "./auth";
import type { HandlerContext, UnaryHandler } from "./handlers";
import type { RegistryRuntime } from "./registry-runtime";

/**
 * Per-socket state machine for the unary `/rpc` endpoint.
 *
 * Wire contract (framework/ws-protocol.ts + ws-rpc-client.ts): each accepted
 * socket carries exactly one RPC -
 *   client `open { token, manifest }`
 *     → host verifies bearer + runs the compatibility oracle
 *     → host `openAck { manifest }` (or `fatalError` + close)
 *   client `request { requestId, method, schemaVersion, params }`
 *     → host `response { requestId, method, schemaVersion, result | error }`
 *   client closes 1000 "ok".
 *
 * On-wire versioning is asymmetric (the older side never transforms): the
 * request's `schemaVersion` is always a version both sides have installed,
 * so when it is older than this host's canonical the dispatcher upgrades the
 * request to canonical, runs the handler, and downgrades the response back.
 *
 * The host also enforces a post-open idle timeout matching the client's
 * 30s frame timeout so neither side holds a dangling connection.
 */
const POST_OPEN_TIMEOUT_MS = 30_000;

export interface RpcConnectionDeps {
  readonly registry: VersionedRpcRegistry;
  readonly runtime: RegistryRuntime;
  readonly manifest: ConnectionManifest;
  readonly verifier: BearerVerifier;
  readonly handlers: ReadonlyMap<string, UnaryHandler>;
}

export interface RpcSocket {
  send(frame: string): void;
  close(code: number, reason: string): void;
}

type Phase = "awaiting-open" | "awaiting-request" | "dispatching" | "done";

export class RpcConnection {
  private readonly deps: RpcConnectionDeps;
  private readonly socket: RpcSocket;
  private phase: Phase = "awaiting-open";
  private context: HandlerContext | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: RpcConnectionDeps, socket: RpcSocket) {
    this.deps = deps;
    this.socket = socket;
    this.armTimeout();
  }

  handleClose(): void {
    this.phase = "done";
    this.clearTimeout();
  }

  async handleMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.fatal({
        code: "RPC_ERROR",
        reason: "malformed client frame (invalid JSON)",
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }
    const frame = clientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      this.fatal({
        code: "RPC_ERROR",
        reason: "malformed client frame",
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }

    if (frame.data.kind === "fatalError") {
      // The client is telling us its mirror check failed; nothing to answer.
      this.phase = "done";
      this.clearTimeout();
      return;
    }

    if (frame.data.kind === "open") {
      if (this.phase !== "awaiting-open") {
        this.fatal({
          code: "RPC_ERROR",
          reason: "unexpected open frame",
          incompatibleMethods: null,
          upgradeGuidance: null,
        });
        return;
      }
      await this.handleOpen(frame.data.token, frame.data.manifest);
      return;
    }

    if (this.phase !== "awaiting-request") {
      this.fatal({
        code: "RPC_ERROR",
        reason: "request frame before a successful open",
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }
    this.phase = "dispatching";
    this.clearTimeout();
    await this.handleRequest(frame.data);
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

    const compat = checkCompatibility(
      this.deps.registry,
      this.deps.manifest,
      clientManifest,
      "host",
    );
    if (!compat.ok) {
      this.fatal(compat.details);
      return;
    }

    this.context = { userId: verdict.userId };
    this.phase = "awaiting-request";
    this.armTimeout();
    this.emit({ kind: "openAck", manifest: this.deps.manifest });
  }

  private async handleRequest(frame: {
    readonly requestId: string;
    readonly method: string;
    readonly schemaVersion: { readonly major: number; readonly minor: number };
    readonly params: unknown;
  }): Promise<void> {
    const context = this.context;
    if (context === null) {
      this.fatal({
        code: "RPC_ERROR",
        reason: "request without an authenticated open",
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }

    const respond = (
      result: unknown | null,
      error: { readonly code: string; readonly message: string } | null,
    ): void => {
      this.emit({
        kind: "response",
        requestId: frame.requestId,
        method: frame.method,
        schemaVersion: frame.schemaVersion,
        result,
        error,
      });
      this.phase = "done";
    };

    const runtime = this.deps.runtime;
    if (!runtime.hasVersion(frame.method, frame.schemaVersion)) {
      respond(null, {
        code: "RPC_ERROR",
        message: `unknown method/version: ${frame.method}@${frame.schemaVersion.major}.${frame.schemaVersion.minor}`,
      });
      return;
    }

    const handler = this.deps.handlers.get(frame.method);
    if (handler === undefined) {
      respond(null, {
        code: "RPC_ERROR",
        message: `method not implemented in @traycer/open-host: ${frame.method}`,
      });
      return;
    }

    // Validate the inbound payload at its on-wire version before bridging so
    // a bad client payload surfaces as a request error, not a bridge crash.
    const wireContract = runtime.contractAt(frame.method, frame.schemaVersion);
    const wireRequest = wireContract.requestSchema.safeParse(frame.params);
    if (!wireRequest.success) {
      respond(null, {
        code: "RPC_ERROR",
        message: `invalid request payload for ${frame.method}@${frame.schemaVersion.major}.${frame.schemaVersion.minor}`,
      });
      return;
    }

    try {
      const canonicalRequest = runtime.upgradeRequestToCanonical(
        frame.method,
        frame.schemaVersion,
        wireRequest.data,
      );
      const canonicalResponse = await handler(canonicalRequest, context);
      const downgraded = runtime.downgradeResponseFromCanonical(
        frame.method,
        frame.schemaVersion,
        canonicalResponse,
      );
      if (!downgraded.ok) {
        respond(null, downgraded.error);
        return;
      }
      respond(downgraded.value, null);
    } catch (cause) {
      respond(null, {
        code: "RPC_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private emit(frame: HostFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  private fatal(details: FatalErrorDetails): void {
    this.phase = "done";
    this.clearTimeout();
    this.emit({ kind: "fatalError", details });
    this.socket.close(1000, details.code);
  }

  private armTimeout(): void {
    this.clearTimeout();
    this.timer = setTimeout(() => {
      if (this.phase === "awaiting-open" || this.phase === "awaiting-request") {
        this.phase = "done";
        this.socket.close(1000, "idle-timeout");
      }
    }, POST_OPEN_TIMEOUT_MS);
  }

  private clearTimeout(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
