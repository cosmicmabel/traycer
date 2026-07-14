type EventProperties = Record<string, unknown> | null;

export enum AnalyticsEvent {
  TaskCreated = "task_created",
  TaskOpened = "task_opened",
  TaskShared = "task_shared",
  ChatMessageSent = "chat_message_sent",
  CommandPaletteOpened = "command_palette_opened",
  TerminalOpened = "terminal_opened",
  HarnessChanged = "harness_changed",
  HistoryNavigationUsed = "history_navigation_used",
}

/**
 * No-op analytics. CIC is local-only software and ships NO telemetry: nothing
 * is collected, nothing leaves the machine. The call-site API is kept so
 * event intent stays documented in the code (and a self-hoster could wire a
 * local sink here if they ever wanted one).
 */
export class Analytics {
  private static instance: Analytics | null = null;

  static getInstance(): Analytics {
    if (Analytics.instance === null) Analytics.instance = new Analytics();
    return Analytics.instance;
  }

  identify(userId: string, properties: EventProperties): void {
    void userId;
    void properties;
  }

  reset(): void {}

  track(event: AnalyticsEvent, properties: EventProperties): void {
    void event;
    void properties;
  }
}
