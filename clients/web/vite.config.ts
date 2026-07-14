import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig, type HtmlTagDescriptor, type UserConfig } from "vite";
import { CONTENT_SECURITY_POLICY } from "./src/shell/content-security-policy";

const webEnvPrefix = [
  "VITE_APP_",
  "VITE_TRAYCER_OSS_REPO",
  "VITE_VIRTUOSO_MESSAGE_LIST_LICENSE_KEY",
];

/**
 * Web (browser) shell Vite config.
 *
 * Builds `src/shell/index.html` + `src/shell/main.tsx` into `dist/`. The shell
 * consumes `@traycer-clients/gui-app` as a workspace library - exactly like
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

  return {
    root: resolve(__dirname, "src", "shell"),
    base: "./",
    publicDir: false,
    envPrefix: webEnvPrefix,
    plugins: [
      // Inject the CSP <meta> from the single directive list
      // (src/shell/content-security-policy.ts) so the built page always ships
      // its policy regardless of which server fronts the static bundle.
      {
        name: "traycer-inject-csp-meta",
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
        "@traycer-clients/gui-app": resolve(guiAppRoot, "index.ts"),
        "@traycer-clients/shared": sharedRoot,
        // Cross-workspace imports that gui-app makes at runtime - the
        // tsconfig `paths` entries cover type-checking, but vite needs
        // explicit aliases so dependency pre-bundling can resolve them.
        // The `utils` entry must precede the bare `@traycer/protocol`
        // entry so vite matches the longer prefix first.
        "@traycer/protocol/utils": resolve(protocolRoot, "utils"),
        "@traycer/protocol": resolve(protocolRoot, "src"),
      },
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
