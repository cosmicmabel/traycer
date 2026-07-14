import {
  tseslint,
  globals,
  commonIgnores,
  linterOptionsConfig,
} from "../eslint/flat-base.mjs";
import { cicTypeSafetyRestrictions } from "../eslint/cic-type-safety-rules.mjs";

export default tseslint.config(
  {
    ignores: [...commonIgnores],
  },
  linterOptionsConfig,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2021 },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-restricted-syntax": ["error", ...cicTypeSafetyRestrictions],
    },
  },
);
