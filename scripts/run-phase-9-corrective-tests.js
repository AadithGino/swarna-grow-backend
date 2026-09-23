#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const files = [
  "tests/production-hardening-phase9.test.js",
  "tests/financial-percent.test.js",
  "tests/export-branch-scope.test.js",
  "tests/admin-mutation-dto-phase8.test.js",
];

const result = spawnSync(
  process.execPath,
  ["--test", ...files],
  { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } },
);

process.exit(result.status ?? 1);
