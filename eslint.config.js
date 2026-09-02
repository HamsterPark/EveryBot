import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // ui/index.html carries a small inline script that is not type-checked TypeScript.
  { ignores: ["dist/**", "node_modules/**", "data/**", "coverage/**", "ui/**"] },
];
