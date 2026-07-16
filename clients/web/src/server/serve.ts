import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join, normalize, resolve } from "node:path";
import {
  readHostPidMetadata,
  upstreamHostUrl,
  type HostPidMetadata,
} from "./host-pid";
import {
  MIN_PASSWORD_LENGTH,
  WebAuthStore,
  bunPasswordHasher,
  clearedSessionCookie,
  sessionCookie,
  sessionTokenFromRequest,
  webAuthPath,
} from "./web-auth";

/**
 * The Bun process that hosts the GUI as a webapp on a Linux machine running
 * the host server.
 *
 * Three jobs (see clients/web/README.md):
 *  1. Serve the built static bundle (`clients/web/dist`) with an SPA
 *     fallback to `index.html`.
 *  2. Proxy `/host/rpc` + `/host/stream` WebSockets to the local host's
 *     loopback WebSocket endpoints (from the pid.json discovery file).
 *     The host binds 127.0.0.1 only, so this same-origin proxy is what makes
 *     the GUI reachable from another machine - and it sidesteps the
 *     HTTPS-page→ws://127.0.0.1 mixed-content block.
 *  3. Serve `GET /api/runtime-config` - the host snapshot the browser shell
 *     bootstraps from (re-read from pid.json per call so the page tracks
 *     host restarts).
 *
 * The stack is local-only: there is no external auth service anywhere -
 * this process makes NO outbound network connections. Access is protected
 * by a machine-local password (created on the first visit, argon2id-hashed
 * in `~/.cic/web-auth.json`, HttpOnly cookie sessions - see web-auth.ts);
 * the static bundle and `/api/auth/*` are the only unauthenticated routes.
 * `--no-auth` disables the gate for pure-loopback setups.
 *
 * SECURITY: with `--no-auth`, this port is an unauthenticated door to the
 * local host. It binds 127.0.0.1 by default; `--bind 0.0.0.0` is an
 * explicit opt-in for trusted LANs.
 */

interface ServeOptions {
  readonly port: number;
  readonly bind: string;
  readonly environment: string;
  readonly distDir: string;
  /** `--no-auth`: serve without the local password gate. */
  readonly noAuth: boolean;
}

const DEFAULT_PORT = 8788;
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_ENVIRONMENT = "production";

function parseArgs(argv: readonly string[]): ServeOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
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
      continue;
    }
    flags.add(arg.slice(2));
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
    noAuth: flags.has("no-auth"),
  };
}

// ─── Auth endpoints ─────────────────────────────────────────────────────────

async function readPasswordBody(request: Request): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const password = (parsed as Record<string, unknown>).password;
  return typeof password === "string" ? password : null;
}

async function handleAuthRoute(
  request: Request,
  url: URL,
  auth: WebAuthStore | null,
): Promise<Response> {
  if (url.pathname === "/api/auth/status") {
    if (auth === null) {
      return Response.json({
        authRequired: false,
        passwordSet: false,
        authenticated: true,
      });
    }
    const authenticated = await auth.verifySession(
      sessionTokenFromRequest(request),
    );
    return Response.json({
      authRequired: true,
      passwordSet: await auth.passwordSet(),
      authenticated,
    });
  }
  if (auth === null || request.method !== "POST") {
    return new Response("not found", { status: 404 });
  }
  if (url.pathname === "/api/auth/setup") {
    const password = await readPasswordBody(request);
    if (password === null) {
      return new Response("bad request", { status: 400 });
    }
    const result = await auth.setup(password);
    if (result.kind === "already-set") {
      return new Response("password already set", { status: 409 });
    }
    if (result.kind === "too-short") {
      return new Response(
        `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        { status: 422 },
      );
    }
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": sessionCookie(result.token) } },
    );
  }
  if (url.pathname === "/api/auth/login") {
    const password = await readPasswordBody(request);
    if (password === null) {
      return new Response("bad request", { status: 400 });
    }
    const result = await auth.login(password);
    if (result.kind === "locked") {
      return new Response("too many attempts - try again shortly", {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)),
        },
      });
    }
    if (result.kind === "invalid") {
      return new Response("wrong password", { status: 401 });
    }
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": sessionCookie(result.token) } },
    );
  }
  if (url.pathname === "/api/auth/logout") {
    await auth.logout(sessionTokenFromRequest(request));
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": clearedSessionCookie() } },
    );
  }
  return new Response("not found", { status: 404 });
}

// ─── Runtime config ─────────────────────────────────────────────────────────

function runtimeConfigResponse(metadata: HostPidMetadata | null): Response {
  return Response.json({
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

// ─── Static bundle ──────────────────────────────────────────────────────────

/**
 * Cache policy for a served file.
 *
 * `index.html` must never be cached: it names the content-hashed asset bundles,
 * so a stale copy pins the browser to an old build even after a redeploy (this
 * is the classic "I rebuilt but the browser still shows the old app"). Files
 * under `assets/` ARE content-hashed, so their names change on every build and
 * the old names are safe to cache forever. Everything else revalidates.
 */
function cacheControlFor(relative: string): string {
  if (relative === "index.html") {
    return "no-cache, no-store, must-revalidate";
  }
  if (relative.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

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
    return new Response(file, {
      headers: { "Cache-Control": cacheControlFor(relative) },
    });
  }
  // A request that looks like a file (has an extension) but doesn't exist is a
  // genuine 404 — never fall back to index.html for it, or a missing
  // `/assets/x.js` would be served as HTML and trip the browser's strict MIME
  // check. Only extensionless routes get the SPA fallback.
  const lastSegment = relative.slice(relative.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) {
    return new Response("not found", { status: 404 });
  }
  // SPA fallback: every non-asset route renders index.html and the router
  // takes over client-side. Served no-store so a redeploy is picked up on the
  // next load without a manual hard-refresh.
  const index = Bun.file(join(distDir, "index.html"));
  if (await index.exists()) {
    return new Response(index, {
      headers: { "Cache-Control": cacheControlFor("index.html") },
    });
  }
  return new Response(
    "clients/web/dist is missing - run `bunx nx run @cic/web:build` first",
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
  const auth = options.noAuth
    ? null
    : new WebAuthStore(webAuthPath(options.environment), bunPasswordHasher);

  const server = Bun.serve<ProxySocketData>({
    hostname: options.bind,
    port: options.port,
    async fetch(request, serverInstance) {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/api/auth/")) {
        return handleAuthRoute(request, url, auth);
      }

      // Everything that reaches the host (or reveals its state) requires a
      // session; the static bundle stays open so the login screen can render.
      const guarded =
        url.pathname === "/host/rpc" ||
        url.pathname === "/host/stream" ||
        url.pathname === "/api/runtime-config";
      if (guarded && auth !== null) {
        const ok = await auth.verifySession(sessionTokenFromRequest(request));
        if (!ok) {
          return new Response("unauthorized", { status: 401 });
        }
      }

      if (url.pathname === "/host/rpc" || url.pathname === "/host/stream") {
        const metadata = await readHostPidMetadata(options.environment);
        if (metadata === null) {
          return new Response(
            "no running host (pid.json not found) - start it with `bun host/src/index.ts`",
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
        return runtimeConfigResponse(metadata);
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
    `cic-web serving ${options.distDir} on http://${options.bind}:${server.port} (host environment: ${options.environment})`,
  );
  console.log(
    auth === null
      ? "auth: DISABLED (--no-auth) - anyone who can reach this port has the host."
      : `auth: local password (created on first visit; stored argon2id-hashed in ${webAuthPath(options.environment)} - delete that file to reset it)`,
  );
  if (options.bind !== "127.0.0.1" && options.bind !== "localhost") {
    console.warn(
      auth === null
        ? `WARNING: bound to ${options.bind} with --no-auth - this port is an unauthenticated door to the local host; only expose it on a trusted network.`
        : `NOTE: bound to ${options.bind} - the local password is the only gate; front with TLS if the network is not trusted.`,
    );
  }
  if (!existsSync(join(options.distDir, "index.html"))) {
    console.warn(
      `WARNING: ${options.distDir}/index.html not found - build the bundle with \`bunx nx run @cic/web:build\`.`,
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
