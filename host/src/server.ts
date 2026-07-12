import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { BearerVerifier } from "./auth";
import { ChatSessionStore } from "./chat/chat-session";
import { EpicStore } from "./epic/epic-store";
import { TaskIndex } from "./epic/task-index";
import type { OpenHostConfig } from "./config";
import { GitStatusBroadcaster } from "./git/git-status-broadcaster";
import { buildUnaryHandlers } from "./handlers";
import { OpenClawGatewayProbe } from "./openclaw/gateway-client";
import { RegistryRuntime } from "./registry-runtime";
import { RpcConnection } from "./rpc-connection";
import { StreamConnection } from "./stream-connection";

/**
 * The open host's WS server: `/rpc` (one RPC per socket), `/stream`
 * (long-lived subscriptions), and the unauthenticated loopback HTTP
 * `GET /activity` probe (`clients/shared/host-client/host-activity-probe.ts`
 * treats only an explicit 200 `{"busy":false}` as idle).
 *
 * Binds 127.0.0.1 ONLY - that is part of the pid.json contract
 * (`isValidLocalHostWebsocketUrl` rejects anything else) and the security
 * boundary the clients rely on. Remote access goes through a fronting proxy
 * (e.g. the clients/web serve process).
 */
interface ConnectionData {
  connection: RpcConnection | StreamConnection | null;
  readonly endpoint: "rpc" | "stream";
}

export interface RunningOpenHost {
  readonly port: number;
  stop(): void;
}

export function startOpenHostServer(config: OpenHostConfig): RunningOpenHost {
  const runtime = new RegistryRuntime(hostRpcRegistry);
  const rpcManifest = runtime.buildManifest();
  const streamManifest = buildStreamManifest(hostStreamRpcRegistry);
  const verifier = new BearerVerifier(
    config.authnBaseUrl,
    config.insecureNoAuth,
  );
  const gatewayOptions = {
    url: config.openclawGatewayUrl,
    token: config.openclawGatewayToken,
  };
  const openclaw = new OpenClawGatewayProbe(gatewayOptions);
  const chats = new ChatSessionStore(gatewayOptions, config.environment);
  const epics = new EpicStore(config.environment);
  const tasks = new TaskIndex(config.environment);
  const gitStatus = new GitStatusBroadcaster();
  const handlers = buildUnaryHandlers({
    protocolVersion: runtime.canonical("host.status"),
    openclaw,
    tasks,
    chats,
    epics,
  });

  const server = Bun.serve<ConnectionData>({
    hostname: "127.0.0.1",
    port: config.port,
    fetch(request, serverInstance) {
      const url = new URL(request.url);
      if (url.pathname === "/activity") {
        // The open host runs no teardown-sensitive background work yet, so
        // it always reports idle.
        return Response.json({ busy: false });
      }
      if (url.pathname === "/rpc" || url.pathname === "/stream") {
        const upgraded = serverInstance.upgrade(request, {
          data: {
            connection: null,
            endpoint: url.pathname === "/rpc" ? "rpc" : "stream",
          },
        });
        return upgraded
          ? undefined
          : new Response("websocket upgrade required", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const socket = {
          send: (frame: string) => {
            ws.send(frame);
          },
          sendBinary: (bytes: Uint8Array) => {
            ws.send(bytes);
          },
          close: (code: number, reason: string) => {
            ws.close(code, reason);
          },
        };
        ws.data.connection =
          ws.data.endpoint === "rpc"
            ? new RpcConnection(
                {
                  registry: hostRpcRegistry,
                  runtime,
                  manifest: rpcManifest,
                  verifier,
                  handlers,
                },
                socket,
              )
            : new StreamConnection(
                {
                  registry: hostStreamRpcRegistry,
                  manifest: streamManifest,
                  verifier,
                  chats,
                  epics,
                  gitStatus,
                },
                socket,
              );
      },
      message(ws, message) {
        const connection = ws.data.connection;
        if (typeof message !== "string") {
          // Binary frames are the paired payload of the preceding text
          // envelope on a stream session; anywhere else they end the
          // connection per the client's own 4003 convention.
          if (connection instanceof StreamConnection) {
            void connection.handleBinary(new Uint8Array(message));
            return;
          }
          ws.close(4003, "unexpected-binary-frame");
          return;
        }
        void connection?.handleMessage(message);
      },
      close(ws) {
        ws.data.connection?.handleClose();
      },
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("open host server failed to bind a port");
  }
  return {
    port,
    stop: () => {
      server.stop(true);
    },
  };
}
