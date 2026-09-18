import js from "@eslint/js";

export default [
  { ignores: ["node_modules/**", "exports/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { Buffer: "readonly", URL: "readonly", URLSearchParams: "readonly", console: "readonly", fetch: "readonly", AbortSignal: "readonly", process: "readonly", setInterval: "readonly", clearInterval: "readonly", setTimeout: "readonly" } },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }], "no-constant-condition": "error" },
  },
];
