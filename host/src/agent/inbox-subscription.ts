import {
  agentInboxSubscribeOpenRequestSchema,
  type AgentInboxSubscribeServerFrame,
} from "@traycer/protocol/host/agent/inbox";

/**
 * `agent.inbox.subscribe@1.0` sessions. The open host runs no inter-agent
 * message broker, so an inbox never delivers anything: the subscription is
 * valid (agents can monitor without erroring) and quiet — heartbeats are
 * the only traffic.
 */
type InboxEmitter = (frame: AgentInboxSubscribeServerFrame) => void;

export class AgentInboxStream {
  subscribe(input: {
    readonly params: unknown;
    readonly emit: InboxEmitter;
  }): AgentInboxSubscription | null {
    const open = agentInboxSubscribeOpenRequestSchema.safeParse(input.params);
    if (!open.success) {
      return null;
    }
    return new AgentInboxSubscription(input.emit);
  }
}

export class AgentInboxSubscription {
  private readonly emit: InboxEmitter;

  constructor(emit: InboxEmitter) {
    this.emit = emit;
  }

  dispose(): void {
    // Stateless: nothing to release.
  }

  handleFrame(parsed: unknown): void {
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Reflect.get(parsed, "kind") === "ping"
    ) {
      this.emit({ kind: "pong", hasBinaryPayload: false });
    }
  }
}
