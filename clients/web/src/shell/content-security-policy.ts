/**
 * Content-Security-Policy for the web shell, modeled on the desktop
 * renderer's policy (clients/desktop/src/shared/content-security-policy.ts)
 * minus the Electron-only allowances (`sentry-ipc:`, the fixed Vite dev-server
 * origins).
 *
 * The policy ships as a build-time-injected `<meta>` tag (see
 * vite.config.ts's `transformIndexHtml`), so the page carries it regardless
 * of which server fronts the static bundle.
 *
 * Non-obvious allowances:
 *  - `connect-src 'self'` covers the same-origin `/host/rpc` + `/host/stream`
 *    WebSocket proxy and the `/authn/*` reverse proxy exposed by the serve
 *    process (src/server/serve.ts); `ws:`/`wss:` cover the absolute-URL form
 *    of the same-origin WebSocket dial.
 *  - `img-src https:` lets remote user avatars load, matching desktop.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: ws:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
] as const;

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");
