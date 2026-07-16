import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "path";
import { defineConfig, type HtmlTagDescriptor, type UserConfig } from "vite";
import { CONTENT_SECURITY_POLICY } from "./src/shell/content-security-policy";

const webEnvPrefix = [
  "VITE_APP_",
  "VITE_CIC_OSS_REPO",
  "VITE_VIRTUOSO_MESSAGE_LIST_LICENSE_KEY",
];

/**
 * The version string baked into the build, read back by `appVersionLabel()`
 * (clients/gui-app/src/lib/app-version.ts) for the Settings › General "Version"
 * row and the onboarding footer.
 *
 * Precedence: an explicit `VITE_APP_VERSION` (set at release) wins; otherwise
 * the gui-app package version is combined with the short git SHA
 * (`0.1.0+ad46db0`) so every deploy shows a DIFFERENT, verifiable value — the
 * whole point of the row is to confirm at a glance which build is live. Falls
 * back to the bare package version when git isn't available (e.g. a source
 * tarball with no `.git`).
 */
function resolveWebAppVersion(guiAppRoot: string): string {
  const fromEnv = process.env.VITE_APP_VERSION;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  const pkgVersion = ((): string => {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(resolve(guiAppRoot, "package.json"), "utf8"),
      );
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
      return "0.0.0";
    } catch {
      return "0.0.0";
    }
  })();
  const sha = ((): string => {
    try {
      return execSync("git rev-parse --short HEAD", {
        cwd: guiAppRoot,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      return "";
    }
  })();
  return sha.length > 0 ? `${pkgVersion}+${sha}` : pkgVersion;
}

/**
 * Web (browser) shell Vite config.
 *
 * Builds `src/shell/index.html` + `src/shell/main.tsx` into `dist/`. The shell
 * consumes `@cic/gui-app` as a workspace library - exactly like
 * the desktop renderer - so this config mirrors
 * `clients/desktop/vite.renderer.config.ts` hunk-for-hunk (minus Sentry and
 * the Electron dev-server wiring).
 *
 * KEEP IN SYNC with clients/desktop/vite.renderer.config.ts: both configs run
 * the TanStack Router codegen against the SAME `gui-app/src/routes` directory
 * and regenerate the SAME `gui-app/src/routeTree.gen.ts`. That is safe only
 * while the `tanstackRouter` options here stay byte-identical to the desktop
 * config's; do not run the desktop and web dev servers concurrently.
 */
export default defineConfig((): UserConfig => {
  const port = Number(process.env.PORT) || 5180;
  const guiAppRoot = resolve(__dirname, "..", "gui-app");
  const sharedRoot = resolve(__dirname, "..", "shared");
  const protocolRoot = resolve(__dirname, "..", "..", "protocol");
  const appVersion = resolveWebAppVersion(guiAppRoot);

  return {
    root: resolve(__dirname, "src", "shell"),
    // Absolute asset base so a deep link (e.g. /settings/foo) still resolves
    // `/assets/*` from the server root instead of `./assets/*` relative to the
    // current path — the serve process rewrites every non-asset route to
    // index.html, so nested URLs must not depend on their own depth.
    base: "/",
    publicDir: false,
    envPrefix: webEnvPrefix,
    plugins: [
      // Inject the CSP <meta> from the single directive list
      // (src/shell/content-security-policy.ts) so the built page always ships
      // its policy regardless of which server fronts the static bundle.
      {
        name: "cic-inject-csp-meta",
        transformIndexHtml(): HtmlTagDescriptor[] {
          return [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: CONTENT_SECURITY_POLICY,
              },
              injectTo: "head-prepend",
            },
          ];
        },
      },
      tanstackRouter({
        target: "react",
        quoteStyle: "double",
        semicolons: true,
        autoCodeSplitting: true,
        routeFileIgnorePattern: "__tests__|route-components|route-search",
        routesDirectory: resolve(guiAppRoot, "src", "routes"),
        generatedRouteTree: resolve(guiAppRoot, "src", "routeTree.gen.ts"),
      }),
      react(),
      tailwindcss(),
      babel({ presets: [reactCompilerPreset()] }).then((plugin) => ({
        ...plugin,
        enforce: "post" as const,
      })),
    ],
    resolve: {
      alias: {
        "@": resolve(guiAppRoot, "src"),
        "@cic/gui-app": resolve(guiAppRoot, "index.ts"),
        "@cic/shared": sharedRoot,
        // Cross-workspace imports that gui-app makes at runtime - the
        // tsconfig `paths` entries cover type-checking, but vite needs
        // explicit aliases so dependency pre-bundling can resolve them.
        // The `utils` entry must precede the bare `@cic/protocol`
        // entry so vite matches the longer prefix first.
        "@cic/protocol/utils": resolve(protocolRoot, "utils"),
        "@cic/protocol": resolve(protocolRoot, "src"),
      },
    },
    // Bake the resolved version in so `import.meta.env.VITE_APP_VERSION` is a
    // real string in the bundle even when the build ran without the env var set
    // (the common `nx run @cic/web:build` path). Vite's own env injection still
    // wins when `VITE_APP_VERSION` is exported, because `resolveWebAppVersion`
    // prefers it.
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
    },
    build: {
      emptyOutDir: true,
      outDir: resolve(__dirname, "dist"),
      sourcemap: "hidden",
    },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  };
});
