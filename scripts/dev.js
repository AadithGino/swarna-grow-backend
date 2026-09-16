/**
 * Local development: API (watch) + background worker in one terminal.
 * Production still runs API and workers as separate processes.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = process.execPath;
const envFile = path.join(root, ".env");

function spawnNamed(name, entry, { watch = false } = {}) {
  const args = ["--env-file", envFile];
  if (watch) args.push("--watch");
  args.push(entry);

  const child = spawn(node, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal) {
      console.error(`[dev:${name}] stopped (${signal})`);
      shutdown(1);
      return;
    }
    if (code !== 0 && code !== null) {
      console.error(`[dev:${name}] exited with code ${code}`);
      shutdown(code);
    }
  });

  return child;
}

let shuttingDown = false;
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 400).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("[dev] Starting API (watch) + worker…");
children.push(spawnNamed("worker", "src/workers/index.js"));
children.push(spawnNamed("api", "src/server.js", { watch: true }));
