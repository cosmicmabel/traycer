import type { z } from "zod";
import { hostStatusV10 } from "@traycer/protocol/host/status/contracts";
import { hostGetRuntimeCapabilitiesV10 } from "@traycer/protocol/host/runtime-capabilities/contracts";
import {
  agentGuiListHarnessesV40,
  agentGuiListModelsV10,
  agentGuiListCommandsV10,
} from "@traycer/protocol/host/agent/gui/contracts";
import { providersListV40 } from "@traycer/protocol/host/registry";
import {
  PROVIDER_DISPLAY_NAMES,
  providerIdSchema,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import { OPEN_HOST_VERSION } from "./config";
import type { OpenClawGatewayProbe } from "./openclaw/gateway-client";

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

  return handlers;
}
