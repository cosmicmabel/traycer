import type { z } from "zod";
import { hostStatusV10 } from "@traycer/protocol/host/status/contracts";
import { hostGetRuntimeCapabilitiesV10 } from "@traycer/protocol/host/runtime-capabilities/contracts";
import {
  agentGuiListHarnessesV40,
  agentGuiListModelsV10,
  agentGuiListCommandsV10,
} from "@traycer/protocol/host/agent/gui/contracts";
import { agentListV40 } from "@traycer/protocol/host/agent/contracts";
import { commentsListThreadsV10 } from "@traycer/protocol/host/comments/contracts";
import { editorOpenPathsV10 } from "@traycer/protocol/host/editor/contracts";
import { EDITORS } from "@traycer/protocol/host/editor/unary-schemas";
import { hostGetRateLimitUsageV20 } from "@traycer/protocol/host/rate-limit/contracts";
import { providersListV40 } from "@traycer/protocol/host/registry";
import {
  epicBatchDeleteV10,
  epicCreateV10,
  epicCreateChatV10,
  epicDeleteChatV10,
  epicListCollaboratorsV10,
  epicListTasksV10,
  epicMentionEpicsV10,
  epicMentionReviewsV10,
  epicMentionSpecsV10,
  epicMentionStoriesV10,
  epicMentionTicketsV10,
  epicRemoveRepoV10,
  epicRenameChatV10,
  epicUpdateTitleV10,
} from "@traycer/protocol/host/epic/contracts";
import {
  gitGetCapabilitiesV10,
  gitGetFileDiffV10,
  gitGetFileDiffsV10,
  gitListChangedFilesV11,
} from "@traycer/protocol/host/git-contracts";
import {
  workspaceListDirectoryV10,
  workspaceListFileTreeV10,
  workspaceMentionFilesV10,
  workspaceMentionFoldersV10,
  workspaceMentionGitBranchesV10,
  workspaceMentionGitCommitsV10,
  workspaceMentionGitRootV10,
  workspaceMentionWorktreesV10,
  workspacePrepareFoldersV10,
  workspaceReadFileV10,
  workspaceResolvePathsByRepoIdentifiersV10,
} from "@traycer/protocol/host/workspace/contracts";
import type { EpicLightWithPermission } from "@traycer/protocol/host/epic/unary-schemas";
import {
  PROVIDER_DISPLAY_NAMES,
  providerIdSchema,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { ChatSessionStore } from "./chat/chat-session";
import { OPEN_HOST_VERSION } from "./config";
import type { EpicStore } from "./epic/epic-store";
import type { TaskIndex } from "./epic/task-index";
import type { OpenClawGatewayProbe } from "./openclaw/gateway-client";
import {
  getFileDiff,
  getFileDiffs,
  getGitCapabilities,
  gitStatusSnapshot,
} from "./git/git-service";
import {
  listDirectory,
  listFileTree,
  mentionFiles,
  mentionFolders,
  mentionGitBranches,
  mentionGitCommits,
  mentionGitRoot,
  mentionWorktrees,
  prepareWorkspaceFolders,
  readWorkspaceFile,
} from "./workspace/workspace-service";

/**
 * Unary method handlers.
 *
 * Every handler is registered at the method's CANONICAL contract: the
 * dispatcher upgrades older on-wire requests to canonical before calling and
 * downgrades the canonical response afterwards (see rpc-connection.ts), so
 * handlers never see wire-version skew.
 *
 * The open host implements the surface the GUI needs to boot plus the
 * OpenClaw catalog; every other method in `hostRpcRegistry` is answered with
 * a structured `RPC_ERROR` ("not implemented in @traycer/open-host") rather
 * than a handshake failure, because the connection manifest must advertise
 * every method (a missing method fails compatibility for the whole
 * connection, framework/compatibility-checker.ts).
 */
export interface HandlerContext {
  readonly userId: string;
}

export type UnaryHandler = (
  params: unknown,
  context: HandlerContext,
) => Promise<unknown>;

interface HandlerContract<
  RequestSchema extends z.ZodType,
  ResponseSchema extends z.ZodType,
> {
  readonly method: string;
  readonly schemaVersion: { readonly major: number; readonly minor: number };
  readonly requestSchema: RequestSchema;
  readonly responseSchema: ResponseSchema;
}

function contractHandler<
  RequestSchema extends z.ZodType,
  ResponseSchema extends z.ZodType,
>(
  contract: HandlerContract<RequestSchema, ResponseSchema>,
  resolve: (
    request: z.output<RequestSchema>,
    context: HandlerContext,
  ) => Promise<z.input<ResponseSchema>>,
): UnaryHandler {
  return async (params, context) => {
    const request = contract.requestSchema.parse(params);
    const response = await resolve(request, context);
    return contract.responseSchema.parse(response);
  };
}

export interface HandlerDeps {
  readonly protocolVersion: {
    readonly major: number;
    readonly minor: number;
  };
  readonly openclaw: OpenClawGatewayProbe;
  readonly tasks: TaskIndex;
  readonly chats: ChatSessionStore;
  readonly epics: EpicStore;
}

const OPENCLAW_PROVIDER_ID: ProviderId = "openclaw";

/**
 * Fallback model row when the local OpenClaw Gateway does not answer a model
 * listing: the gateway owns model/config resolution, so the open host
 * advertises a single "gateway default" entry and forwards the slug as-is.
 */
const OPENCLAW_DEFAULT_MODEL_SLUG = "openclaw/default";

function providerRow(
  providerId: ProviderId,
  input: {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly detail: string | null;
  },
): ProviderCliState {
  return {
    providerId,
    enabled: input.enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: input.available
        ? "authenticated"
        : input.enabled
          ? "unknown"
          : "unavailable",
      badgeText: null,
      label: input.available ? PROVIDER_DISPLAY_NAMES[providerId] : null,
      detail: input.detail,
    },
    authPending: false,
    checkedAt: Date.now(),
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
  };
}

function openclawHarnessOption(gatewayReachable: boolean): GuiHarnessOption {
  return {
    id: "openclaw",
    label: PROVIDER_DISPLAY_NAMES[OPENCLAW_PROVIDER_ID],
    enabled: true,
    available: gatewayReachable,
    error: gatewayReachable
      ? null
      : "OpenClaw Gateway is not reachable on this machine",
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: [
      "supervised",
      "auto_accept_edits",
      "full_access",
    ],
    availabilityPending: false,
  };
}

export function buildUnaryHandlers(
  deps: HandlerDeps,
): ReadonlyMap<string, UnaryHandler> {
  const handlers = new Map<string, UnaryHandler>();

  handlers.set(
    hostStatusV10.method,
    contractHandler(hostStatusV10, async () => ({
      ready: true,
      hostVersion: OPEN_HOST_VERSION,
      protocolVersion: deps.protocolVersion,
    })),
  );

  handlers.set(
    hostGetRuntimeCapabilitiesV10.method,
    contractHandler(hostGetRuntimeCapabilitiesV10, async () => ({
      chatMessageList: {
        status: "available",
        provider: "virtuoso-message-list",
        licenseMode: "development-trial",
        licenseKey: "",
      } as const,
    })),
  );

  handlers.set(
    providersListV40.method,
    contractHandler(providersListV40, async () => {
      const gatewayReachable = await deps.openclaw.isReachable();
      return {
        providers: providerIdSchema.options.map((providerId) =>
          providerId === OPENCLAW_PROVIDER_ID
            ? providerRow(providerId, {
                enabled: true,
                available: gatewayReachable,
                detail: gatewayReachable
                  ? "Local OpenClaw Gateway"
                  : "Start the OpenClaw Gateway to enable this provider",
              })
            : providerRow(providerId, {
                enabled: false,
                available: false,
                detail: "Not implemented in @traycer/open-host yet",
              }),
        ),
      };
    }),
  );

  handlers.set(
    agentGuiListHarnessesV40.method,
    contractHandler(agentGuiListHarnessesV40, async () => ({
      harnesses: [openclawHarnessOption(await deps.openclaw.isReachable())],
    })),
  );

  handlers.set(
    agentGuiListModelsV10.method,
    contractHandler(agentGuiListModelsV10, async (request) => ({
      harnessId: request.harnessId,
      models:
        request.harnessId === "openclaw"
          ? [
              {
                harnessId: "openclaw" as const,
                slug: OPENCLAW_DEFAULT_MODEL_SLUG,
                label: "OpenClaw (gateway default)",
                description:
                  "Model selection is owned by the local OpenClaw Gateway configuration.",
                contextWindow: null,
                maxOutputTokens: null,
                defaultReasoningEffort: null,
                supportedReasoningEfforts: [],
                defaultServiceTier: null,
                supportedServiceTiers: [],
                metadata: {},
              },
            ]
          : [],
    })),
  );

  handlers.set(
    agentGuiListCommandsV10.method,
    contractHandler(agentGuiListCommandsV10, async (request) => ({
      harnessId: request.harnessId,
      commands: [],
    })),
  );

  // ── Epic surface (local task index + Y.Doc seeding; no cloud) ───────────

  handlers.set(
    epicCreateV10.method,
    contractHandler(epicCreateV10, async (request, context) => {
      const now = Date.now();
      const taskRef = { taskId: request.epic.id, taskType: "epic" as const };
      const row: EpicLightWithPermission = {
        light: request.epic,
        // Single-user local host: the connection's bearer IS the owner, so
        // no permission DTO is synthesized (the schema allows null and the
        // GUI treats a null permission as owner-visible local state).
        permission: null,
        repos: request.repoIdentifiers.map((repoIdentifier) => ({
          task: taskRef,
          repoIdentifier,
          createdAt: now,
          createdBy: context.userId,
        })),
        workspaces: request.workspaces.map((workspace) => ({
          task: taskRef,
          hostId: "open-host",
          workspacePath: workspace.workspacePath,
          createdAt: now,
        })),
        roomInfo: null,
      };
      await deps.tasks.upsert(row);
      if (request.chat !== null && request.chat !== undefined) {
        const chatRecord = await deps.chats.ensureChat({
          epicId: request.epic.id,
          chatId: request.chat.chatId,
          userId: context.userId,
          title: request.chat.title,
        });
        await deps.epics.seedChat(request.epic.id, chatRecord);
      }
      return {
        roomInfo: null,
        task: { epic: row },
        // The open host never starts the provider turn from the folded
        // initialMessage; the renderer's stream-driven fallback sends it.
        initialTurnStarted: request.chat === null ? null : false,
      };
    }),
  );

  handlers.set(
    epicListTasksV10.method,
    contractHandler(epicListTasksV10, async (request) => ({
      tasks: (await deps.tasks.list(request.limit)).map((row) => ({
        epic: row,
      })),
      hasMore: false,
    })),
  );

  handlers.set(
    epicCreateChatV10.method,
    contractHandler(epicCreateChatV10, async (request, context) => {
      const chatRecord = await deps.chats.ensureChat({
        epicId: request.epicId,
        chatId: request.chatId,
        userId: context.userId,
        title: request.title,
      });
      await deps.epics.seedChat(request.epicId, chatRecord);
      return { chatId: request.chatId, initialTurnStarted: false };
    }),
  );

  handlers.set(
    epicBatchDeleteV10.method,
    contractHandler(epicBatchDeleteV10, async (request) => {
      const results = [];
      for (const taskId of request.ids) {
        const removed = await deps.tasks.remove(taskId);
        if (removed) {
          await deps.epics.deleteEpic(taskId);
          await deps.chats.deleteEpicChats(taskId);
          results.push({ taskId, success: true });
        } else {
          results.push({
            taskId,
            success: false,
            errorMessage: "epic not found in the local task index",
          });
        }
      }
      return { results };
    }),
  );

  handlers.set(
    epicListCollaboratorsV10.method,
    contractHandler(epicListCollaboratorsV10, async () => ({
      // Single-user local host: no collaborator directory exists, and
      // `collaboratorsAvailable: false` tells the GUI to hide sharing UI
      // rather than render an empty owner list.
      collaborators: [],
      collaboratorsAvailable: false,
    })),
  );

  handlers.set(
    epicUpdateTitleV10.method,
    contractHandler(epicUpdateTitleV10, async (request) => ({
      updated:
        request.epicDelta === null
          ? false
          : await deps.tasks.applyDelta(request.epicDelta),
    })),
  );

  handlers.set(
    epicRenameChatV10.method,
    contractHandler(epicRenameChatV10, async (request, context) => {
      const chatRecord = await deps.chats.renameChat({
        epicId: request.epicId,
        chatId: request.chatId,
        userId: context.userId,
        title: request.title,
      });
      await deps.epics.seedChat(request.epicId, chatRecord);
      return { updated: true };
    }),
  );

  handlers.set(
    epicDeleteChatV10.method,
    contractHandler(epicDeleteChatV10, async (request) => {
      await deps.chats.deleteChat(request.epicId, request.chatId);
      await deps.epics.removeChat(request.epicId, request.chatId);
      return { deleted: true };
    }),
  );

  handlers.set(
    epicRemoveRepoV10.method,
    contractHandler(epicRemoveRepoV10, async (request) => ({
      success: await deps.tasks.removeRepo(
        request.epicId,
        request.repoIdentifier,
      ),
    })),
  );

  // ── Workspace surface (local filesystem + git; see workspace-service) ────

  handlers.set(
    workspacePrepareFoldersV10.method,
    contractHandler(workspacePrepareFoldersV10, async (request) =>
      prepareWorkspaceFolders(request.folderPaths),
    ),
  );

  handlers.set(
    workspaceResolvePathsByRepoIdentifiersV10.method,
    contractHandler(
      workspaceResolvePathsByRepoIdentifiersV10,
      async (request) => ({
        mappings: await deps.tasks.resolveWorkspacePaths(
          request.repoIdentifiers,
        ),
      }),
    ),
  );

  handlers.set(
    workspaceListFileTreeV10.method,
    contractHandler(workspaceListFileTreeV10, async (request) =>
      listFileTree(request),
    ),
  );

  handlers.set(
    workspaceListDirectoryV10.method,
    contractHandler(workspaceListDirectoryV10, async (request) =>
      listDirectory(request),
    ),
  );

  handlers.set(
    workspaceReadFileV10.method,
    contractHandler(workspaceReadFileV10, async (request) =>
      readWorkspaceFile(request),
    ),
  );

  handlers.set(
    workspaceMentionFilesV10.method,
    contractHandler(workspaceMentionFilesV10, async (request) =>
      mentionFiles(request),
    ),
  );

  handlers.set(
    workspaceMentionFoldersV10.method,
    contractHandler(workspaceMentionFoldersV10, async (request) =>
      mentionFolders(request),
    ),
  );

  handlers.set(
    workspaceMentionWorktreesV10.method,
    contractHandler(workspaceMentionWorktreesV10, async (request) =>
      mentionWorktrees(request),
    ),
  );

  handlers.set(
    workspaceMentionGitRootV10.method,
    contractHandler(workspaceMentionGitRootV10, async (request) =>
      mentionGitRoot(request),
    ),
  );

  handlers.set(
    workspaceMentionGitBranchesV10.method,
    contractHandler(workspaceMentionGitBranchesV10, async (request) =>
      mentionGitBranches(request),
    ),
  );

  handlers.set(
    workspaceMentionGitCommitsV10.method,
    contractHandler(workspaceMentionGitCommitsV10, async (request) =>
      mentionGitCommits(request),
    ),
  );

  // ── Small single-shape methods (agent roster, quotas, mentions, misc) ────

  handlers.set(
    agentListV40.method,
    contractHandler(agentListV40, async (request) => ({
      // No multi-agent runtime on the open host: the caller is the only
      // agent it knows, and it cannot message peers.
      caller: { agentId: request.senderAgentId, canSendMessages: false },
      scope: request.scope,
      agents: [],
    })),
  );

  handlers.set(
    hostGetRateLimitUsageV20.method,
    contractHandler(hostGetRateLimitUsageV20, async () => ({
      // The open host proxies no Traycer-cloud inference, so there is no
      // aperture quota behind this method; zeros read as "no budget tracked".
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: null,
    })),
  );

  handlers.set(
    epicMentionEpicsV10.method,
    contractHandler(epicMentionEpicsV10, async (request) => {
      const rows = await deps.tasks.list(request.limit * 4);
      const query = request.query.toLowerCase();
      return {
        entries: rows
          .flatMap((row) => (row.light === null ? [] : [row.light]))
          .filter(
            (light) =>
              query.length === 0 || light.title.toLowerCase().includes(query),
          )
          .slice(0, request.limit)
          .map((light) => ({
            kind: "epic" as const,
            // `epic:<id>` matches the GUI's local-epic suggestion builder so
            // host and local copies of the same epic de-dupe to one entry.
            id: `epic:${light.id}`,
            token: `epic:${light.id}`,
            epicId: light.id,
            label: light.title,
            description: light.initialUserPrompt,
            status: light.status,
            updatedAt: light.updatedAt,
          })),
      };
    }),
  );

  // Artifact mentions (specs/tickets/stories/reviews) need the artifact
  // index the closed host keeps; the open host has no artifacts yet, so the
  // pickers get empty (not failed) suggestion lists.
  handlers.set(
    epicMentionSpecsV10.method,
    contractHandler(epicMentionSpecsV10, async () => ({ entries: [] })),
  );
  handlers.set(
    epicMentionTicketsV10.method,
    contractHandler(epicMentionTicketsV10, async () => ({ entries: [] })),
  );
  handlers.set(
    epicMentionStoriesV10.method,
    contractHandler(epicMentionStoriesV10, async () => ({ entries: [] })),
  );
  handlers.set(
    epicMentionReviewsV10.method,
    contractHandler(epicMentionReviewsV10, async () => ({ entries: [] })),
  );

  handlers.set(
    commentsListThreadsV10.method,
    contractHandler(commentsListThreadsV10, async () => ({
      // No comment-thread store on the open host yet; an empty artifact
      // list renders as "no comments" rather than a failed panel.
      artifacts: [],
    })),
  );

  handlers.set(
    editorOpenPathsV10.method,
    contractHandler(editorOpenPathsV10, async (request) => {
      // Best-effort on a headless host: hand the editor's URL scheme to the
      // OS opener and ignore failures (the contract has no failure channel).
      const editor = EDITORS.find((entry) => entry.id === request.editorId);
      if (editor !== undefined) {
        for (const path of request.paths) {
          Bun.spawn(["xdg-open", `${editor.urlScheme}://file${path}`], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          }).exited.catch(() => undefined);
        }
      }
      return {};
    }),
  );

  // ── Git surface (status snapshots + stage-scoped diffs) ──────────────────

  handlers.set(
    gitGetCapabilitiesV10.method,
    contractHandler(gitGetCapabilitiesV10, async (request) =>
      getGitCapabilities(request.runningDir),
    ),
  );

  handlers.set(
    gitListChangedFilesV11.method,
    contractHandler(gitListChangedFilesV11, async (request) => {
      // Canonical v1.1: parent-only view. The open host does not fan out
      // into submodules yet, so every row carries `gitlink: null` and
      // `submodules` stays empty even when `includeSubmodules` is set.
      const snapshot = await gitStatusSnapshot(request.runningDir);
      return {
        ...snapshot,
        files: snapshot.files.map((file) => ({ ...file, gitlink: null })),
        submodules: [],
      };
    }),
  );

  handlers.set(
    gitGetFileDiffV10.method,
    contractHandler(gitGetFileDiffV10, async (request) => getFileDiff(request)),
  );

  handlers.set(
    gitGetFileDiffsV10.method,
    contractHandler(gitGetFileDiffsV10, async (request) =>
      getFileDiffs(request),
    ),
  );

  return handlers;
}
