import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { agentInboxReadV10 } from "@traycer/protocol/host/agent/inbox";
import {
  snapshotsClearLocalSnapshotsV10,
  snapshotsGetLocalStorageSizeV10,
  snapshotsReadSnapshotDiffV10,
} from "@traycer/protocol/host/registry";
import {
  speechEnsureModelV10,
  speechGetModelStatusV10,
} from "@traycer/protocol/host/speech/contracts";
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
import {
  terminalCreateV10,
  terminalKillV10,
  terminalListV10,
  terminalRenameV10,
} from "@traycer/protocol/host/terminal/contracts";
import {
  providersAddCustomPathV20,
  providersAwaitLoginV20,
  providersCancelLoginV10,
  providersClearApiKeyV20,
  providersDeleteEnvOverrideV20,
  providersDetectVersionV10,
  providersListV40,
  providersRemoveCustomPathV20,
  providersSetApiKeyV20,
  providersSetEnabledV20,
  providersSetEnvOverrideV20,
  providersSetSelectionV20,
  providersSetTerminalAgentArgsV20,
  providersStartLoginV10,
  workspaceBindingRemoveEntryV10,
  worktreeCreatePathsV10,
  worktreeCreateV10,
  worktreeDeleteV10,
  worktreeGetBindingV10,
  worktreeImportV10,
  worktreeListAllForHostV11,
  worktreeListBindingsForEpicV11,
  worktreeListBranchesV10,
  worktreeListByWorkspacePathsV11,
  worktreeRetrySetupV10,
  worktreeSetEntryModeV10,
  worktreeSetRepoScriptsV10,
} from "@traycer/protocol/host/registry";
import {
  epicBatchDeleteV10,
  epicCreateArtifactV10,
  epicCreateV10,
  epicCreateChatV10,
  epicDeleteArtifactV10,
  epicDeleteChatV10,
  epicListCollaboratorsV10,
  epicListTasksV10,
  epicMentionEpicsV10,
  epicMentionReviewsV10,
  epicMentionSpecsV10,
  epicMentionStoriesV10,
  epicMentionTicketsV10,
  epicCreateCommentThreadV10,
  epicCreateTuiAgentV10,
  epicDeleteCommentThreadV10,
  epicDeleteCommentV10,
  epicDeleteTuiAgentV10,
  epicRenameTuiAgentV10,
  epicEditCommentV10,
  epicListCommentThreadsV10,
  epicRemoveRepoV10,
  epicRenameArtifactV10,
  epicRenameChatV10,
  epicReparentArtifactV10,
  epicReparentChatV10,
  epicResolveArtifactByPathV10,
  epicReplyToCommentThreadV10,
  epicSetCommentThreadResolvedV10,
  epicUpdateArtifactStatusV10,
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
import type { CommentStore } from "./epic/comment-store";
import type { EpicStore } from "./epic/epic-store";
import type { TaskIndex } from "./epic/task-index";
import type { OpenClawGatewayProbe } from "./openclaw/gateway-client";
import {
  buildProviderState,
  type ProviderSettingsStore,
} from "./providers/provider-settings";
import type { TerminalStore } from "./terminal/terminal-store";
import type { BindingStore } from "./worktree/binding-store";
import {
  createWorktreeAt,
  materializeIntent,
  perEntryFailed,
  perEntryOk,
  removeWorktreeDir,
  startSetupIfConfigured,
  writeScriptsFile,
} from "./worktree/worktree-mutations";
import {
  ensureFolderlessCwd,
  listBindingSelectorRows,
  listBranches,
  listByWorkspacePaths,
  listHostWorktrees,
} from "./worktree/worktree-service";
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
  readonly environment: string;
  readonly openclaw: OpenClawGatewayProbe;
  readonly tasks: TaskIndex;
  readonly chats: ChatSessionStore;
  readonly epics: EpicStore;
  readonly terminals: TerminalStore;
  readonly bindings: BindingStore;
  readonly comments: CommentStore;
  readonly providerSettings: ProviderSettingsStore;
}

const OPENCLAW_PROVIDER_ID: ProviderId = "openclaw";

/**
 * Fallback model row when the local OpenClaw Gateway does not answer a model
 * listing: the gateway owns model/config resolution, so the open host
 * advertises a single "gateway default" entry and forwards the slug as-is.
 */
const OPENCLAW_DEFAULT_MODEL_SLUG = "openclaw/default";

/**
 * The dictation engine (sherpa addon) does not ship with the open host, so
 * every speech RPC reports the same "engine unavailable" snapshot — the
 * renderer never shows the mic or attempts a model download.
 */
function speechUnavailable(modelId: string | null): {
  modelId: string;
  installed: boolean;
  downloadState: "absent";
  downloadProgress: null;
  sizeBytes: null;
  errorMessage: null;
  engineAvailable: boolean;
} {
  return {
    modelId: modelId ?? "default",
    installed: false,
    downloadState: "absent",
    downloadProgress: null,
    sizeBytes: null,
    errorMessage: null,
    engineAvailable: false,
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

  const stateFor = async (providerId: ProviderId) =>
    buildProviderState(
      await deps.providerSettings.get(providerId),
      providerId === OPENCLAW_PROVIDER_ID
        ? await deps.openclaw.isReachable()
        : false,
    );

  handlers.set(
    providersListV40.method,
    contractHandler(providersListV40, async () => ({
      providers: await Promise.all(
        providerIdSchema.options.map((providerId) => stateFor(providerId)),
      ),
    })),
  );

  // ── Provider settings mutations (persisted; echoed in every state) ───────

  handlers.set(
    providersSetEnabledV20.method,
    contractHandler(providersSetEnabledV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        enabled: request.enabled,
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersSetTerminalAgentArgsV20.method,
    contractHandler(providersSetTerminalAgentArgsV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        terminalAgentArgs: request.terminalAgentArgs,
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersSetEnvOverrideV20.method,
    contractHandler(providersSetEnvOverrideV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        envOverrides: [
          ...row.envOverrides.filter((entry) => entry.key !== request.key),
          { key: request.key, value: request.value },
        ],
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersDeleteEnvOverrideV20.method,
    contractHandler(providersDeleteEnvOverrideV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        envOverrides: row.envOverrides.filter(
          (entry) => entry.key !== request.key,
        ),
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersSetApiKeyV20.method,
    contractHandler(providersSetApiKeyV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        apiKey: request.apiKey,
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersClearApiKeyV20.method,
    contractHandler(providersClearApiKeyV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        apiKey: null,
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersAddCustomPathV20.method,
    contractHandler(providersAddCustomPathV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        customPaths: [
          ...row.customPaths.filter((path) => path !== request.path),
          request.path,
        ],
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersRemoveCustomPathV20.method,
    contractHandler(providersRemoveCustomPathV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        customPaths: row.customPaths.filter((path) => path !== request.path),
        selection:
          row.selection.kind === "custom" && row.selection.path === request.path
            ? { kind: "bundled" as const }
            : row.selection,
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersSetSelectionV20.method,
    contractHandler(providersSetSelectionV20, async (request) => {
      await deps.providerSettings.mutate(request.providerId, (row) => ({
        ...row,
        selection: request.selection,
      }));
      return { state: await stateFor(request.providerId) };
    }),
  );

  handlers.set(
    providersDetectVersionV10.method,
    contractHandler(providersDetectVersionV10, async (request) => {
      // Probe the candidate binary with `--version`; a non-executable or
      // failing binary reports executable: false.
      try {
        const child = Bun.spawn([request.candidatePath, "--version"], {
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
        });
        const output = await new Response(child.stdout).text();
        const exitCode = await child.exited;
        return {
          executable: exitCode === 0,
          version: exitCode === 0 ? output.trim().split("\n")[0] : null,
        };
      } catch {
        return { executable: false, version: null };
      }
    }),
  );

  handlers.set(
    providersStartLoginV10.method,
    contractHandler(providersStartLoginV10, async () => ({
      // No provider CLI login flows on the open host (the OpenClaw Gateway
      // owns its own auth); `started: false` renders the "can't start
      // login" state instead of hanging a spinner.
      url: null,
      started: false,
    })),
  );

  handlers.set(
    providersAwaitLoginV20.method,
    contractHandler(providersAwaitLoginV20, async () => ({
      // Nothing to await: no login is ever in flight on this host.
      state: null,
    })),
  );

  handlers.set(
    providersCancelLoginV10.method,
    contractHandler(providersCancelLoginV10, async () => ({
      cancelled: false,
    })),
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
    contractHandler(epicUpdateTitleV10, async (request) => {
      if (request.epicDelta === null) {
        return { updated: false };
      }
      const updated = await deps.tasks.applyDelta(request.epicDelta);
      if (updated && request.epicDelta.title !== undefined) {
        // Mirror the new title into the epic doc so canvas headers update.
        await deps.epics.setTitle(
          request.epicDelta.id,
          request.epicDelta.title,
        );
      }
      return { updated };
    }),
  );

  // ── Epic artifact + tree mutations (Y.Doc writes; see epic-store.ts) ─────

  handlers.set(
    epicCreateArtifactV10.method,
    contractHandler(epicCreateArtifactV10, async (request) => ({
      artifactId: await deps.epics.createArtifact(request.epicId, {
        parentId: request.parentId,
        artifactType: request.artifactType,
        title: request.title,
      }),
    })),
  );

  handlers.set(
    epicDeleteArtifactV10.method,
    contractHandler(epicDeleteArtifactV10, async (request) => ({
      deleted: await deps.epics.deleteArtifact(
        request.epicId,
        request.artifactId,
      ),
    })),
  );

  handlers.set(
    epicRenameArtifactV10.method,
    contractHandler(epicRenameArtifactV10, async (request) => ({
      updated: await deps.epics.renameArtifact(
        request.epicId,
        request.artifactId,
        request.title,
      ),
    })),
  );

  handlers.set(
    epicReparentArtifactV10.method,
    contractHandler(epicReparentArtifactV10, async (request) => ({
      updated: await deps.epics.reparentArtifact(
        request.epicId,
        request.artifactId,
        request.newParentId,
      ),
    })),
  );

  handlers.set(
    epicUpdateArtifactStatusV10.method,
    contractHandler(epicUpdateArtifactStatusV10, async (request) => ({
      updated: await deps.epics.updateArtifactStatus(
        request.epicId,
        request.artifactId,
        request.status,
      ),
    })),
  );

  handlers.set(
    epicReparentChatV10.method,
    contractHandler(epicReparentChatV10, async (request) => ({
      updated: await deps.epics.reparentChat(
        request.epicId,
        request.chatId,
        request.newParentId,
      ),
    })),
  );

  handlers.set(
    epicResolveArtifactByPathV10.method,
    contractHandler(epicResolveArtifactByPathV10, async () => ({
      // The open host keeps no artifact→file-path index; `null` renders the
      // "no linked artifact" state rather than an error.
      artifact: null,
    })),
  );

  // ── TUI-agent cards (Y.Doc `tuiAgents` section; launch stays TBD) ────────

  handlers.set(
    epicCreateTuiAgentV10.method,
    contractHandler(epicCreateTuiAgentV10, async (request, context) => {
      const tuiAgentId = request.tuiAgentId ?? randomUUID();
      await deps.epics.seedTuiAgent(request.epicId, {
        id: tuiAgentId,
        title: request.title,
        parentId: request.parentId,
        userId: context.userId,
        hostId: request.hostId,
        harnessId: request.harnessId,
        harnessSessionId: request.harnessSessionId,
        workspaceFolders: request.workspaceFolders,
        workspaceMode: request.workspaceMode ?? null,
      });
      return { tuiAgentId };
    }),
  );

  handlers.set(
    epicRenameTuiAgentV10.method,
    contractHandler(epicRenameTuiAgentV10, async (request) => ({
      updated: await deps.epics.renameTuiAgent(
        request.epicId,
        request.tuiAgentId,
        request.title,
      ),
    })),
  );

  handlers.set(
    epicDeleteTuiAgentV10.method,
    contractHandler(epicDeleteTuiAgentV10, async (request) => ({
      deleted: await deps.epics.deleteTuiAgent(
        request.epicId,
        request.tuiAgentId,
      ),
    })),
  );

  // ── Snapshots / speech / inbox (no local stores behind them) ─────────────

  handlers.set(
    snapshotsGetLocalStorageSizeV10.method,
    contractHandler(snapshotsGetLocalStorageSizeV10, async () => ({
      // No file-edit snapshot store on the open host yet.
      bytes: 0,
    })),
  );

  handlers.set(
    snapshotsClearLocalSnapshotsV10.method,
    contractHandler(snapshotsClearLocalSnapshotsV10, async () => ({
      clearedBytes: 0,
    })),
  );

  handlers.set(
    snapshotsReadSnapshotDiffV10.method,
    contractHandler(snapshotsReadSnapshotDiffV10, async () => ({
      // Content-addressed blobs never existed here; `blob_missing` renders
      // the block's "content unavailable" state.
      beforeContent: null,
      afterContent: null,
      reason: "blob_missing" as const,
    })),
  );

  handlers.set(
    speechGetModelStatusV10.method,
    contractHandler(speechGetModelStatusV10, async (request) =>
      speechUnavailable(request.modelId),
    ),
  );

  handlers.set(
    speechEnsureModelV10.method,
    contractHandler(speechEnsureModelV10, async (request) =>
      speechUnavailable(request.modelId),
    ),
  );

  handlers.set(
    agentInboxReadV10.method,
    contractHandler(agentInboxReadV10, async () => ({
      // No multi-agent broker on the open host; an empty inbox is the
      // correct reading, not a failure.
      messages: [],
    })),
  );

  // ── Comment threads (local JSON store; see epic/comment-store.ts) ────────

  handlers.set(
    epicListCommentThreadsV10.method,
    contractHandler(epicListCommentThreadsV10, async (request) => ({
      threads: await deps.comments.list(request),
    })),
  );

  handlers.set(
    epicCreateCommentThreadV10.method,
    contractHandler(epicCreateCommentThreadV10, async (request, context) => ({
      threadId: await deps.comments.createThread({
        ref: request,
        userId: context.userId,
        content: request.content,
        quotedText: request.quotedText,
      }),
    })),
  );

  handlers.set(
    epicReplyToCommentThreadV10.method,
    contractHandler(epicReplyToCommentThreadV10, async (request, context) => {
      await deps.comments.reply({
        ref: request,
        threadId: request.threadId,
        userId: context.userId,
        content: request.content,
      });
      return { ok: true as const };
    }),
  );

  handlers.set(
    epicEditCommentV10.method,
    contractHandler(epicEditCommentV10, async (request) => {
      await deps.comments.editComment({
        ref: request,
        threadId: request.threadId,
        commentId: request.commentId,
        content: request.content,
      });
      return { ok: true as const };
    }),
  );

  handlers.set(
    epicDeleteCommentV10.method,
    contractHandler(epicDeleteCommentV10, async (request) => {
      await deps.comments.deleteComment({
        ref: request,
        threadId: request.threadId,
        commentId: request.commentId,
      });
      return { ok: true as const };
    }),
  );

  handlers.set(
    epicSetCommentThreadResolvedV10.method,
    contractHandler(epicSetCommentThreadResolvedV10, async (request) => {
      await deps.comments.setResolved(
        request,
        request.threadId,
        request.resolved,
      );
      return { ok: true as const };
    }),
  );

  handlers.set(
    epicDeleteCommentThreadV10.method,
    contractHandler(epicDeleteCommentThreadV10, async (request) => {
      await deps.comments.deleteThread(request, request.threadId);
      return { ok: true as const };
    }),
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

  // ── Worktree read slice (branch/workspace listings for the pickers) ──────

  handlers.set(
    worktreeListBranchesV10.method,
    contractHandler(worktreeListBranchesV10, async (request) =>
      listBranches(request),
    ),
  );

  handlers.set(
    worktreeListByWorkspacePathsV11.method,
    contractHandler(worktreeListByWorkspacePathsV11, async (request) =>
      listByWorkspacePaths(request),
    ),
  );

  handlers.set(
    worktreeGetBindingV10.method,
    contractHandler(worktreeGetBindingV10, async (request) => {
      const row = await deps.bindings.get(request);
      return {
        binding: row?.binding ?? null,
        missingWorktreePaths: await deps.bindings.missingWorktreePaths(
          row?.binding ?? null,
        ),
      };
    }),
  );

  handlers.set(
    worktreeListBindingsForEpicV11.method,
    contractHandler(worktreeListBindingsForEpicV11, async (request) => ({
      rows: await listBindingSelectorRows(deps.bindings, request.epicId),
      // Folderless epics still get terminals: a host-owned cwd is minted
      // lazily under the host home for this epic.
      folderlessCwd: await ensureFolderlessCwd(
        deps.environment,
        request.epicId,
      ),
    })),
  );

  handlers.set(
    worktreeListAllForHostV11.method,
    contractHandler(worktreeListAllForHostV11, async (request) => ({
      worktrees: await listHostWorktrees({
        environment: deps.environment,
        bindings: deps.bindings,
        includeActivity: request.includeActivity,
        activityPaths: request.activityPaths,
      }),
    })),
  );

  handlers.set(
    worktreeCreateV10.method,
    contractHandler(worktreeCreateV10, async (request) => {
      const owner = {
        epicId: request.epicId,
        ownerKind: request.ownerKind,
        ownerId: request.ownerId,
      };
      const entries = [];
      const perEntry = [];
      for (const intent of request.entries) {
        const outcome = await materializeIntent({
          environment: deps.environment,
          terminals: deps.terminals,
          bindings: deps.bindings,
          owner,
          intent,
        });
        if (outcome.entry !== null) {
          entries.push(outcome.entry);
        }
        perEntry.push(outcome.perEntry);
      }
      const binding = {
        workspaceMode:
          entries.length === 0 ? ("folderless" as const) : ("inherit" as const),
        entries,
      };
      await deps.bindings.set(owner, binding);
      return { binding, perEntry };
    }),
  );

  handlers.set(
    worktreeCreatePathsV10.method,
    contractHandler(worktreeCreatePathsV10, async (request) => {
      const entries = [];
      const perEntry = [];
      for (const entry of request.entries) {
        const created = await createWorktreeAt(
          deps.environment,
          entry.workspacePath,
          entry.branch,
        );
        if ("errorMessage" in created) {
          perEntry.push(
            perEntryFailed(entry.workspacePath, created.errorMessage),
          );
          continue;
        }
        entries.push({
          workspacePath: entry.workspacePath,
          path: created.worktreePath,
          mode: "worktree" as const,
          repoIdentifier: created.repoIdentifier,
          branch: created.branch,
        });
        perEntry.push(
          perEntryOk(entry.workspacePath, created.worktreePath, created.branch),
        );
      }
      return { entries, perEntry };
    }),
  );

  handlers.set(
    worktreeImportV10.method,
    contractHandler(worktreeImportV10, async (request) => {
      const owner = {
        epicId: request.epicId,
        ownerKind: request.ownerKind,
        ownerId: request.ownerId,
      };
      const entries = [];
      for (const entry of request.entries) {
        const outcome = await materializeIntent({
          environment: deps.environment,
          terminals: deps.terminals,
          bindings: deps.bindings,
          owner,
          intent:
            entry.worktreePath === null
              ? {
                  kind: "local",
                  workspacePath: entry.workspacePath,
                  repoIdentifier: entry.repoIdentifier,
                  isPrimary: entry.isPrimary,
                }
              : {
                  kind: "import",
                  workspacePath: entry.workspacePath,
                  repoIdentifier: entry.repoIdentifier,
                  isPrimary: entry.isPrimary,
                  worktreePath: entry.worktreePath,
                },
        });
        if (outcome.entry !== null) {
          entries.push(outcome.entry);
        }
      }
      const binding = { workspaceMode: "inherit" as const, entries };
      await deps.bindings.set(owner, binding);
      return { binding };
    }),
  );

  handlers.set(
    worktreeSetEntryModeV10.method,
    contractHandler(worktreeSetEntryModeV10, async (request) => ({
      binding: await deps.bindings.update(request, (binding) => ({
        ...binding,
        entries: binding.entries.map((entry) =>
          entry.workspacePath === request.workspacePath
            ? { ...entry, mode: "local" as const }
            : entry,
        ),
      })),
    })),
  );

  handlers.set(
    workspaceBindingRemoveEntryV10.method,
    contractHandler(workspaceBindingRemoveEntryV10, async (request) => ({
      binding: await deps.bindings.update(request, (binding) => ({
        ...binding,
        entries: binding.entries.filter(
          (entry) => entry.workspacePath !== request.workspacePath,
        ),
      })),
    })),
  );

  handlers.set(
    worktreeRetrySetupV10.method,
    contractHandler(worktreeRetrySetupV10, async (request) => {
      const row = await deps.bindings.get(request);
      const entry = row?.binding.entries.find(
        (candidate) => candidate.workspacePath === request.workspacePath,
      );
      if (
        row === null ||
        row === undefined ||
        entry === undefined ||
        entry.worktreePath === null
      ) {
        return {
          binding: row?.binding ?? { entries: [] },
          terminalSessionId: null,
        };
      }
      const setup = await startSetupIfConfigured({
        terminals: deps.terminals,
        bindings: deps.bindings,
        owner: request,
        workspacePath: request.workspacePath,
        worktreePath: entry.worktreePath,
      });
      const binding = await deps.bindings.update(request, (current) => ({
        ...current,
        entries: current.entries.map((candidate) =>
          candidate.workspacePath === request.workspacePath
            ? {
                ...candidate,
                setupState:
                  setup.setupState === "running"
                    ? ("running" as const)
                    : ("not_required" as const),
                setupTerminalSessionId: setup.terminalSessionId,
                setupExitCode: null,
                setupFailedAt: null,
              }
            : candidate,
        ),
      }));
      return { binding, terminalSessionId: setup.terminalSessionId };
    }),
  );

  handlers.set(
    worktreeSetRepoScriptsV10.method,
    contractHandler(worktreeSetRepoScriptsV10, async (request) => ({
      updated: await writeScriptsFile(request.workspacePath, {
        setup: request.setup,
        teardown: request.teardown,
      }),
    })),
  );

  handlers.set(
    worktreeDeleteV10.method,
    contractHandler(worktreeDeleteV10, async (request) => ({
      deleted: await removeWorktreeDir(request.worktreePath),
    })),
  );

  // ── Terminal surface (host-owned PTYs; see terminal/terminal-store.ts) ───

  handlers.set(
    terminalCreateV10.method,
    contractHandler(terminalCreateV10, async (request) => ({
      session: deps.terminals.create(request),
    })),
  );

  handlers.set(
    terminalListV10.method,
    contractHandler(terminalListV10, async (request) => ({
      sessions: deps.terminals.list(request.epicId),
    })),
  );

  handlers.set(
    terminalKillV10.method,
    contractHandler(terminalKillV10, async (request) => ({
      killed: deps.terminals.kill(request.sessionId),
    })),
  );

  handlers.set(
    terminalRenameV10.method,
    contractHandler(terminalRenameV10, async (request) => ({
      updated: deps.terminals.rename(request.sessionId, request.title),
    })),
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
