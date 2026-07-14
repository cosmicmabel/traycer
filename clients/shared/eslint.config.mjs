import {
  tseslint,
  globals,
  commonIgnores,
  linterOptionsConfig,
} from "../../eslint/flat-base.mjs";
import { cicTypeSafetyRestrictions } from "../../eslint/cic-type-safety-rules.mjs";
import { cicClientsImportBoundaryRestrictions } from "../../eslint/cic-clients-import-boundary-rules.mjs";

export default tseslint.config(
  { ignores: [...commonIgnores, "dist-sea/**"] },
  linterOptionsConfig,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...globals.es2021 },
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
