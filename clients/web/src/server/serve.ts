import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join, normalize, resolve } from "node:path";
import {
  readHostPidMetadata,
  upstreamHostUrl,
  type HostPidMetadata,
} from "./host-pid";

/**
 * `traycer-web serve` - the Bun process that hosts the Traycer GUI as a
 * webapp on a Linux machine running the Traycer host.
 *
 * Four jobs (see clients/web/README.md):
 *  1. Serve the built static bundle (`clients/web/dist`) with an SPA
 *     fallback to `index.html`.
 *  2. Proxy `/host/rpc` + `/host/stream` WebSockets to the local host's
 *     loopback WebSocket endpoints (from `~/.traycer/host[/…]/pid.json`).
 *     The host binds 127.0.0.1 only, so this same-origin proxy is what makes
 *     the GUI reachable from another machine - and it sidesteps the
 *     HTTPS-page→ws://127.0.0.1 mixed-content block.
 *  3. Reverse-proxy `/authn/*` to the Traycer authn service so the page's
 *     auth calls are same-origin (the authn endpoints don't allow arbitrary
 *     browser origins; desktop dodges the same CORS wall via Electron main).
 *  4. Serve `GET /api/runtime-config` - the host snapshot + sign-in config
 *     the browser shell bootstraps from (re-read from pid.json per call so
 *     the page tracks host restarts).
 *
 * SECURITY: this port is an unauthenticated door to the local Traycer host
 * (host RPCs authenticate the bearer the page supplies, but anyone who can
 * reach this port can serve themselves the page). It binds 127.0.0.1 by
 * default; `--bind 0.0.0.0` is an explicit opt-in for trusted LANs.
 */

interface ServeOptions {
  readonly port: number;
  readonly bind: string;
  readonly environment: string;
  readonly distDir: string;
  readonly signInUrl: string;
  readonly authnUpstream: string;
}

const DEFAULT_PORT = 8788;
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_ENVIRONMENT = "production";
const DEFAULT_SIGN_IN_URL = "https://platform.traycer.ai";
const DEFAULT_AUTHN_UPSTREAM = "https://authn.traycer.ai";

function parseArgs(argv: readonly string[]): ServeOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(arg.slice(2), next);
      i += 1;
    }
  }
  const port = Number(values.get("port") ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid --port: ${values.get("port")}`);
  }
  return {
    port,
    bind: values.get("bind") ?? DEFAULT_BIND,
    environment: values.get("environment") ?? DEFAULT_ENVIRONMENT,
    distDir: resolve(
      values.get("dist") ?? resolve(import.meta.dir, "..", "..", "dist"),
    ),
    signInUrl: values.get("sign-in-url") ?? DEFAULT_SIGN_IN_URL,
    authnUpstream: values.get("authn-url") ?? DEFAULT_AUTHN_UPSTREAM,
  };
}

// ─── Runtime config ─────────────────────────────────────────────────────────

function runtimeConfigResponse(
  options: ServeOptions,
  metadata: HostPidMetadata | null,
): Response {
  return Response.json({
    signInUrl: options.signInUrl,
    systemHostName: hostname(),
    host:
      metadata === null
        ? null
        : {
            hostId: metadata.hostId,
            version: metadata.version,
            pid: metadata.pid,
            startedAt: metadata.startedAt,
          },
  });
}

// ─── Authn reverse proxy ────────────────────────────────────────────────────

// Hop-by-hop / origin-bearing headers stripped before forwarding either way.
const STRIPPED_REQUEST_HEADERS = [
  "host",
  "origin",
  "referer",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
];

async function proxyAuthn(
  request: Request,
  url: URL,
  authnUpstream: string,
): Promise<Response> {
  const upstreamUrl = new URL(
    url.pathname.slice("/authn".length) + url.search,
    authnUpstream.endsWith("/") ? authnUpstream : `${authnUpstream}/`,
  );
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      redirect: "manual",
    });
  } catch {
    return new Response("authn upstream unreachable", { status: 502 });
  }
  // Pass the body/status through; drop upstream CORS headers (the page is
  // same-origin with THIS server, so they would only confuse the browser).
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("access-control-allow-origin");
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

// ─── Static bundle ──────────────────────────────────────────────────────────

async function serveStatic(
  distDir: string,
  pathname: string,
): Promise<Response> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^\/+/, "");
  const candidate = join(distDir, relative);
  // `normalize` collapses `..` segments; the prefix check rejects anything
  // that still escapes the bundle directory.
  if (!candidate.startsWith(distDir)) {
    return new Response("forbidden", { status: 403 });
  }
  const file = Bun.file(candidate);
  if (relative.length > 0 && (await file.exists())) {
    return new Response(file);
  }
  // SPA fallback: every non-asset route renders index.html and the router
  // takes over client-side.
  const index = Bun.file(join(distDir, "index.html"));
  if (await index.exists()) {
    return new Response(index);
  }
  return new Response(
    "clients/web/dist is missing - run `bunx nx run @traycer-clients/web:build` first",
    { status: 503 },
  );
}

// ─── WebSocket proxy ────────────────────────────────────────────────────────

interface ProxySocketData {
  readonly upstreamUrl: string;
  upstream: WebSocket | null;
  /** Client frames buffered while the upstream dial is still connecting. */
  readonly pending: Array<string | Uint8Array<ArrayBuffer>>;
}

function startServer(options: ServeOptions): void {
  const server = Bun.serve<ProxySocketData>({
    hostname: options.bind,
    port: options.port,
    async fetch(request, serverInstance) {
      const url = new URL(request.url);

      if (url.pathname === "/host/rpc" || url.pathname === "/host/stream") {
        const metadata = await readHostPidMetadata(options.environment);
        if (metadata === null) {
          return new Response(
            "no running Traycer host (pid.json not found) - run `traycer host install latest` and `traycer host start`",
            { status: 503 },
          );
        }
        const endpoint = url.pathname === "/host/rpc" ? "rpc" : "stream";
        const upgraded = serverInstance.upgrade(request, {
          data: {
            upstream: null,
            pending: [],
            upstreamUrl: upstreamHostUrl(metadata, endpoint),
          },
        });
        return upgraded
          ? undefined
          : new Response("websocket upgrade required", { status: 426 });
      }

      if (url.pathname === "/api/runtime-config") {
        const metadata = await readHostPidMetadata(options.environment);
        return runtimeConfigResponse(options, metadata);
      }

      if (url.pathname === "/authn" || url.pathname.startsWith("/authn/")) {
        return proxyAuthn(request, url, options.authnUpstream);
      }

      return serveStatic(options.distDir, url.pathname);
    },
    websocket: {
      open(ws) {
        const data = ws.data;
        const upstream = new WebSocket(data.upstreamUrl);
        upstream.binaryType = "arraybuffer";
        data.upstream = upstream;
        upstream.onopen = () => {
          for (const frame of data.pending) {
            upstream.send(frame);
          }
          data.pending.length = 0;
        };
        upstream.onmessage = (event: MessageEvent) => {
          if (typeof event.data === "string") {
            ws.send(event.data);
            return;
          }
          ws.send(new Uint8Array(event.data as ArrayBuffer));
        };
        upstream.onclose = (event: CloseEvent) => {
          ws.close(sanitizeCloseCode(event.code), event.reason);
        };
        upstream.onerror = () => {
          ws.close(1011, "upstream host socket error");
        };
      },
      message(ws, message) {
        const data = ws.data;
        const upstream = data.upstream;
        // Copy binary frames into a fresh ArrayBuffer-backed view so the DOM
        // WebSocket `send` signature accepts them (Bun hands a Buffer).
        const frame =
          typeof message === "string" ? message : new Uint8Array(message);
        if (upstream === null || upstream.readyState === WebSocket.CONNECTING) {
          data.pending.push(frame);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(frame);
        }
      },
      close(ws, code, reason) {
        const upstream = ws.data.upstream;
        if (
          upstream !== null &&
          (upstream.readyState === WebSocket.OPEN ||
            upstream.readyState === WebSocket.CONNECTING)
        ) {
          upstream.close(sanitizeCloseCode(code), reason);
        }
      },
    },
  });

  console.log(
    `traycer-web serving ${options.distDir} on http://${options.bind}:${server.port} (host environment: ${options.environment})`,
  );
  if (options.bind !== "127.0.0.1" && options.bind !== "localhost") {
    console.warn(
      `WARNING: bound to ${options.bind} - this port is an unauthenticated door to the local Traycer host; only expose it on a trusted network.`,
    );
  }
  if (!existsSync(join(options.distDir, "index.html"))) {
    console.warn(
      `WARNING: ${options.distDir}/index.html not found - build the bundle with \`bunx nx run @traycer-clients/web:build\`.`,
    );
  }
}

/**
 * Close codes in the 1005/1006/1015 range (and anything outside the
 * RFC 6455 sendable range) cannot be passed to `close()`; collapse them to a
 * generic 1000 so a proxied abnormal closure still propagates.
 */
function sanitizeCloseCode(code: number): number {
  if (code === 1004 || code === 1005 || code === 1006 || code === 1015) {
    return 1000;
  }
  if (code >= 1000 && code <= 4999) {
    return code;
  }
  return 1000;
}

startServer(parseArgs(process.argv.slice(2)));
