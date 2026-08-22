import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import vue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".playwright-browsers", "dist", "public/wasm", "src-tauri/gen"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],
  prettier,
  {
    files: ["src/**/*.{ts,vue}", "tests/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Public runtime/debug envelopes are tagged JSON supplied by Rust. Keeping
      // their payloads dynamic here prevents a second handwritten protocol schema.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/platform/runtime.worker.ts"],
    languageOptions: {
      globals: globals.worker,
    },
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["tests/tauri/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.mocha,
        $: "readonly",
        $$: "readonly",
        browser: "readonly",
      },
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"] },
    },
  },
);
