import {
  tseslint,
  globals,
  commonIgnores,
  linterOptionsConfig,
} from "../../eslint/flat-base.mjs";
import { cicTypeSafetyRestrictions } from "../../eslint/cic-type-safety-rules.mjs";
import { cicClientsImportBoundaryRestrictions } from "../../eslint/cic-clients-import-boundary-rules.mjs";

export default tseslint.config(
  {
    ignores: [...commonIgnores, "vite.config.ts"],
  },
  linterOptionsConfig,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-restricted-syntax": ["error", ...cicTypeSafetyRestrictions],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        cicClientsImportBoundaryRestrictions,
      ],
    },
  },
);
