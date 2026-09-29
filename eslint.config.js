import js from "@eslint/js";

export default [
  { ignores: ["node_modules/**", "exports/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: [
      "**/*.js",
      "scripts/package-source-export.mjs",
      "scripts/verify-source-export-manifest.mjs",
    ],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { Buffer: "readonly", URL: "readonly", URLSearchParams: "readonly", console: "readonly", fetch: "readonly", AbortController: "readonly", AbortSignal: "readonly", process: "readonly", setInterval: "readonly", clearInterval: "readonly", setTimeout: "readonly", clearTimeout: "readonly", globalThis: "readonly" } },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }], "no-constant-condition": "error" },
  },
  {
    files: ["scripts/**/*.spec.js"],
    languageOptions: {
      globals: {
        localStorage: "readonly",
        sessionStorage: "readonly",
        document: "readonly",
        window: "readonly",
      },
    },
  },
];
