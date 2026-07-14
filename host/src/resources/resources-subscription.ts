import {
  resourcesSubscribeOpenRequestV10Schema,
  type ResourcesSubscribeServerFrame,
} from "@cic/protocol/host/resources/subscribe";

/**
 * `resources.subscribe` sessions.
 *
 * The open host tracks no owner process trees yet, so every subscription
 * gets the contract's documented quiet state: one initial snapshot with no
 * app sample, no owners, and a `null` epic aggregate ("not currently
 * tracked", distinct from zero use), then silence apart from heartbeats.
 * The v1.1 open request is a superset of v1.0 (`epicId` stays on the wire),
 * so one non-strict parse covers both installed versions.
 */
type ResourcesEmitter = (frame: ResourcesSubscribeServerFrame) => void;

export class ResourcesSubscriptionFactory {
  subscribe(input: {
    readonly params: unknown;
    readonly emit: ResourcesEmitter;
  }): ResourcesSubscription | null {
    const open = resourcesSubscribeOpenRequestV10Schema.safeParse(input.params);
    if (!open.success) {
      return null;
    }
    return new ResourcesSubscription(open.data.epicId, input.emit);
  }
}

export class ResourcesSubscription {
  private readonly epicId: string;
  private readonly emit: ResourcesEmitter;

  constructor(epicId: string, emit: ResourcesEmitter) {
    this.epicId = epicId;
    this.emit = emit;
  }

  dispose(): void {
    // Stateless: nothing to release.
  }

  emitSnapshot(): void {
    this.emit({
      kind: "snapshot",
      epicId: this.epicId,
      sampledAt: Date.now(),
      app: null,
      owners: [],
      epic: null,
      hasBinaryPayload: false,
    });
  }
}
