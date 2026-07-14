import { randomUUID } from "node:crypto";

/**
 * Minimal client for the OpenClaw Gateway WebSocket control plane.
 *
 * Wire shape (docs.openclaw.ai/gateway/protocol): JSON text frames of three
 * kinds -
 *   request:  { type: "req",   id, method, params }
 *   response: { type: "res",   id, ok, payload | error }
 *   event:    { type: "event", event, payload, seq? }
 * The first client frame must be a `connect` request carrying protocol
 * bounds, client identity, role/scopes, and (when the gateway requires it)
 * an auth token.
 *
 * The open host uses this for two things today:
 *   1. reachability/health probing (drives the `openclaw` provider/harness
 *      availability in the catalogs), and
 *   2. `sendChat` - fire a prompt into a gateway session and stream the
 *      agent's event frames back to a caller-supplied listener. This is the
 *      seam the future `chat.subscribe` stream session plugs into.
 */
export interface OpenClawGatewayOptions {
  readonly url: string;
  readonly token: string | null;
}

export interface OpenClawEvent {
  readonly event: string;
  readonly payload: unknown;
}

type PendingRequest = {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: Error) => void;
};

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

export class OpenClawGatewayConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: OpenClawEvent) => void>();
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  /** Dials the gateway and completes the `connect` handshake. */
  static async connect(
    options: OpenClawGatewayOptions,
  ): Promise<OpenClawGatewayConnection> {
    const socket = new WebSocket(options.url);
    const connection = new OpenClawGatewayConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("openclaw gateway dial timeout"));
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("openclaw gateway dial failed"));
      };
    });
    connection.attach();
    await connection.request("connect", {
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: "cic-open-host",
        version: "0.0.0-open",
        platform: process.platform,
        mode: "operator",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      ...(options.token === null ? {} : { auth: { token: options.token } }),
    });
    return connection;
  }

  onEvent(listener: (event: OpenClawEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error("openclaw gateway connection is closed");
    }
    const id = randomUUID();
    const frame = JSON.stringify({ type: "req", id, method, params });
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`openclaw gateway request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(frame);
    });
  }

  /**
   * Sends a prompt into a gateway chat session and forwards every gateway
   * event to `onAgentEvent` until the returned disposer is called. Session
   * addressing is by `sessionKey`; the gateway creates the session on first
   * use.
   */
  async sendChat(input: {
    readonly sessionKey: string;
    readonly message: string;
    readonly onAgentEvent: (event: OpenClawEvent) => void;
  }): Promise<() => void> {
    const detach = this.onEvent((event) => {
      if (
        event.event.startsWith("chat") ||
        event.event.startsWith("agent") ||
        event.event.startsWith("session") ||
        // Exec/tool approval prompts (e.g. `exec.approval.requested`) ride
        // the same session; the chat layer maps them onto CIC approvals.
        event.event.startsWith("exec") ||
        event.event.includes("approval")
      ) {
        input.onAgentEvent(event);
      }
    });
    await this.request("chat.send", {
      sessionKey: input.sessionKey,
      message: input.message,
      idempotencyKey: randomUUID(),
    });
    return detach;
  }

  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("openclaw gateway connection closed"));
    }
    this.pending.clear();
    this.socket.close();
  }

  private attach(): void {
    this.socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      this.route(parsed);
    };
    this.socket.onclose = () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("openclaw gateway connection closed"));
      }
      this.pending.clear();
    };
  }

  private route(frame: unknown): void {
    if (frame === null || typeof frame !== "object") {
      return;
    }
    const type = Reflect.get(frame, "type");
    if (type === "res") {
      const id = Reflect.get(frame, "id");
      if (typeof id !== "string") {
        return;
      }
      const pending = this.pending.get(id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(id);
      const ok = Reflect.get(frame, "ok");
      if (ok === true) {
        pending.resolve(Reflect.get(frame, "payload"));
        return;
      }
      const error = Reflect.get(frame, "error");
      pending.reject(
        new Error(
          typeof error === "string" ? error : JSON.stringify(error ?? "error"),
        ),
      );
      return;
    }
    if (type === "event") {
      const name = Reflect.get(frame, "event");
      if (typeof name !== "string") {
        return;
      }
      const payload = Reflect.get(frame, "payload");
      for (const listener of this.eventListeners) {
        listener({ event: name, payload });
      }
    }
  }
}

/**
 * Cached reachability probe consumed by the provider/harness catalog
 * handlers. A probe dials the gateway, completes the connect handshake, and
 * closes; verdicts are cached briefly so catalog refreshes stay cheap.
 */
export class OpenClawGatewayProbe {
  private readonly options: OpenClawGatewayOptions;
  private cached: { readonly reachable: boolean; readonly at: number } | null =
    null;

  constructor(options: OpenClawGatewayOptions) {
    this.options = options;
  }

  async isReachable(): Promise<boolean> {
    if (this.cached !== null && Date.now() - this.cached.at < 15_000) {
      return this.cached.reachable;
    }
    let reachable = false;
    try {
      const connection = await OpenClawGatewayConnection.connect(this.options);
      connection.close();
      reachable = true;
    } catch {
      reachable = false;
    }
    this.cached = { reachable, at: Date.now() };
    return reachable;
  }
}
