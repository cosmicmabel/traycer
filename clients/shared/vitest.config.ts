import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@cic/shared",
        replacement: path.resolve(__dirname, "."),
      },
      {
        find: /^@cic\/protocol\/utils\/(.*)$/,
        replacement: path.resolve(__dirname, "../../protocol/utils/$1"),
      },
      {
        find: /^@cic\/protocol\/(.*)$/,
        replacement: path.resolve(__dirname, "../../protocol/src/$1"),
      },
    ],
  },
  test: {
    include: ["**/__tests__/**/*.test.ts"],
    globals: false,
    env: {
      VITE_CIC_OSS_REPO: "https://github.com/cosmicmabel/traycer",
    },
  },
});
