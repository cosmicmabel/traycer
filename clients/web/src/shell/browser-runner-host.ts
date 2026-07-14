import type { AuthIdentityValidationResult } from "@cic/shared/auth/auth-validation-types";
import type {
  AuthTokenRefreshResult,
  AuthTokenValidationResult,
  DeviceFlowAuthorization,
  DeviceFlowResult,
  DeviceFlowSession,
  IDeviceFlowHost,
  IFileDropHost,
  IHostPicker,
  INotificationHost,
  IRunnerHost,
  ITrayState,
  IWorkspaceFoldersHost,
  LocalHostSnapshot,
  MicrophoneAccessStatus,
  TrayEpic,
  TrayIndicatorState,
} from "@cic/shared/platform/runner-host";
import type { Disposable } from "@cic/shared/platform/uri-callback";
import { BrowserSecureStorage, BrowserTokenStore } from "./browser-token-store";
import {
  LOCAL_BEARER_TOKEN,
  LOCAL_REFRESH_TOKEN,
  localAuthProfile,
  localAuthenticatedUser,
} from "./local-session";
import {
  fetchRuntimeConfig,
  hostWebsocketUrlFromLocation,
  type WebRuntimeConfig,
} from "./runtime-config";

/** How often the shell re-reads `/api/runtime-config` to track the host. */
const HOST_POLL_INTERVAL_MS = 3_000;

export interface BrowserRunnerHostOptions {
  readonly config: WebRuntimeConfig;
}

/**
 * `IRunnerHost` for the browser shell served by `cic-web serve`
 * (src/server/serve.ts).
 *
 * Capability posture (see the interface docs in
 * clients/shared/platform/runner-host.ts, which describe the web shell for
 * every member):
 *  - Auth is LOCAL-ONLY: there is no account and no auth service anywhere.
 *    validate/refresh answer with the synthetic local identity
 *    (local-session.ts) and the "device flow" settles instantly - the page
 *    never shows a sign-in.
 *  - `hasLocalHost: true`: the serve process fronts a real local host; the
 *    snapshot stream polls `/api/runtime-config` and advertises the
 *    same-origin `/host/rpc` WebSocket proxy as the dial URL.
 *  - Native-only surfaces (`zoom`, `service`, `cicCli`, `migration`,
 *    `hostManagement`, `hostTray`) are `null`; always-present surfaces with no
 *    browser backing (tray, folder picker, file drops, system-resume) install
 *    the documented no-ops.
 */
export class BrowserRunnerHost implements IRunnerHost {
  readonly signInUrl: string;
  readonly authnBaseUrl: string;
  readonly hasLocalHost: boolean = true;

  readonly secureStorage = new BrowserSecureStorage();
  readonly tokenStore = new BrowserTokenStore();
  readonly deviceFlow: IDeviceFlowHost;

  readonly tray: ITrayState = new BrowserTrayState();
  readonly hostPicker: IHostPicker = new BrowserHostPicker();
  readonly workspaceFolders: IWorkspaceFoldersHost = {
    // No native folder picker in a browser; users enter workspace paths
    // manually (the host resolves them on its own filesystem).
    pickFolders: async (): Promise<readonly string[]> => [],
  };
  readonly fileDrops: IFileDropHost = {
    resolveDroppedFilePaths: async (
      files: readonly File[],
    ): Promise<readonly string[]> => {
      void files;
      // Browsers do not expose real filesystem paths for dropped files.
      return [];
    },
    copyDroppedFilePaths: async (
      paths: readonly string[],
    ): Promise<readonly string[]> => paths,
  };
  readonly notifications: INotificationHost = {
    show: async (title: string, body: string, payload: unknown) => {
      void payload;
      if (typeof Notification === "undefined") {
        return;
      }
      if (Notification.permission === "granted") {
        new Notification(title, { body });
        return;
      }
      if (Notification.permission === "default") {
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
          new Notification(title, { body });
        }
      }
    },
    // Web Notification clicks focus the tab but carry no payload routing.
    onClick: (): Disposable => ({ dispose: () => undefined }),
  };

  readonly zoom: null = null;
  readonly service: null = null;
  readonly cicCli: null = null;
  readonly migration: null = null;
  readonly hostManagement: null = null;
  readonly hostTray: null = null;

  private localHost: LocalHostSnapshot | null;
  private readonly localHostHandlers = new Set<
    (snapshot: LocalHostSnapshot | null) => void
  >();

  constructor(options: BrowserRunnerHostOptions) {
    // There is no sign-in page and no auth service; these URL members exist
    // only to satisfy the platform contract, so they point at the page itself.
    this.signInUrl = window.location.origin;
    this.authnBaseUrl = window.location.origin;
    this.localHost = snapshotFromConfig(options.config);
    this.deviceFlow = new LocalDeviceFlowHost();
    // Track host restarts/upgrades for the lifetime of the page. The page and
    // this runner host share that lifetime, so the interval is never cleared.
    window.setInterval(() => {
      void this.refreshLocalHost();
    }, HOST_POLL_INTERVAL_MS);
  }

  async validateAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenValidationResult> {
    void token;
    void refreshToken;
    return { kind: "valid", profile: localAuthProfile() };
  }

  async validateAuthTokenIdentity(
    token: string,
    refreshToken: string,
  ): Promise<AuthIdentityValidationResult> {
    void token;
    void refreshToken;
    return { kind: "valid", user: localAuthenticatedUser() };
  }

  async refreshAuthToken(
    token: string,
    refreshToken: string,
  ): Promise<AuthTokenRefreshResult> {
    void token;
    void refreshToken;
    // The constant local credential never expires; hand it straight back.
    return {
      kind: "refreshed",
      token: LOCAL_BEARER_TOKEN,
      refreshToken: LOCAL_REFRESH_TOKEN,
    };
  }

  async openExternalLink(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]> {
    void schemes;
    // No OS scheme-handler registry in a browser; offer nothing native.
    return [];
  }

  async requestMicrophoneAccess(): Promise<MicrophoneAccessStatus> {
    // No native gate; `getUserMedia` drives the browser's own prompt.
    return "granted";
  }

  async openMicrophoneSettings(): Promise<void> {
    // No OS settings deep link from a web page.
  }

  beginAuthAttempt(): void {
    // Device flow is poll-only on web (no deep-link callback), so there is
    // no attempt window to reset.
  }

  onAuthCallback(handler: () => void): Disposable {
    void handler;
    // No browser-return signal on web: sign-in completes poll-only, which the
    // `IRunnerHost.onAuthCallback` contract explicitly supports.
    return { dispose: () => undefined };
  }

  onLocalHostChange(
    handler: (snapshot: LocalHostSnapshot | null) => void,
  ): Disposable {
    handler(this.localHost);
    this.localHostHandlers.add(handler);
    return {
      dispose: () => {
        this.localHostHandlers.delete(handler);
      },
    };
  }

  onSystemResumed(handler: () => void): Disposable {
    void handler;
    // No OS wake signal in a browser; gui-app pairs this with the
    // cross-platform `window` `online` event, so recovery degrades gracefully.
    return { dispose: () => undefined };
  }

  async requestHostRespawn(): Promise<void> {
    // Host lifecycle is owned by the serve deployment (systemd unit or
    // container entrypoint), not the page.
  }

  private async refreshLocalHost(): Promise<void> {
    const config = await fetchRuntimeConfig();
    if (config === null) {
      return;
    }
    const next = snapshotFromConfig(config);
    if (sameSnapshot(this.localHost, next)) {
      return;
    }
    this.localHost = next;
    for (const handler of this.localHostHandlers) {
      handler(next);
    }
  }
}

function snapshotFromConfig(
  config: WebRuntimeConfig,
): LocalHostSnapshot | null {
  if (config.host === null) {
    return null;
  }
  return {
    hostId: config.host.hostId,
    websocketUrl: hostWebsocketUrlFromLocation(window.location),
    version: config.host.version,
    pid: config.host.pid,
    systemHostName: config.systemHostName,
    displayName: config.systemHostName,
  };
}

function sameSnapshot(
  a: LocalHostSnapshot | null,
  b: LocalHostSnapshot | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.hostId === b.hostId &&
    a.pid === b.pid &&
    a.version === b.version &&
    a.websocketUrl === b.websocketUrl
  );
}

// ─── Device flow (local mode, instant) ──────────────────────────────────────

/**
 * Local-mode "device flow": settles as authorized with the constant local
 * credential on the first `onResult` subscription, so an explicit sign-in
 * click (e.g. after a sign-out) completes without any browser round trip or
 * authn traffic. The `authorization` fields are placeholders the GUI may
 * briefly render before the settled result lands.
 */
class LocalDeviceFlowHost implements IDeviceFlowHost {
  async start(): Promise<DeviceFlowSession | null> {
    return new LocalDeviceFlowSession();
  }
}

class LocalDeviceFlowSession implements DeviceFlowSession {
  readonly authorization: DeviceFlowAuthorization = {
    userCode: "LOCAL",
    verificationUri: window.location.origin,
    verificationUriComplete: window.location.origin,
    expiresInSeconds: 300,
    intervalSeconds: 1,
  };

  private cancelled = false;

  onResult(handler: (result: DeviceFlowResult) => void): Disposable {
    if (this.cancelled) {
      return { dispose: () => undefined };
    }
    // Same settled-result replay contract as the real controller: the
    // attempt is already authorized by the time anyone subscribes.
    handler({
      kind: "authorized",
      token: LOCAL_BEARER_TOKEN,
      refreshToken: LOCAL_REFRESH_TOKEN,
    });
    return { dispose: () => undefined };
  }

  pollNow(): void {
    // Nothing to poll; the result is settled from construction.
  }

  cancel(): void {
    this.cancelled = true;
  }
}

// ─── Always-present no-op surfaces ──────────────────────────────────────────

/** No native tray on web; setters record nothing and clicks never fire. */
class BrowserTrayState implements ITrayState {
  async setEpics(epics: readonly TrayEpic[]): Promise<void> {
    void epics;
  }

  async setIndicator(state: TrayIndicatorState): Promise<void> {
    void state;
  }

  onEpicSelected(handler: (epicId: string) => void): Disposable {
    void handler;
    return { dispose: () => undefined };
  }
}

/**
 * In-page host-picker controller: the web shell has no separate native
 * surface, so open/close state lives here and gui-app renders the picker.
 */
class BrowserHostPicker implements IHostPicker {
  private open = false;
  private readonly handlers = new Set<(isOpen: boolean) => void>();

  get isOpen(): boolean {
    return this.open;
  }

  requestOpen(): void {
    if (this.open) {
      return;
    }
    this.open = true;
    this.emit();
  }

  requestClose(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.emit();
  }

  onChange(handler: (isOpen: boolean) => void): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  private emit(): void {
    for (const handler of this.handlers) {
      handler(this.open);
    }
  }
}
