import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const abs = path.join(root, "tests/gateway-settlement-resolution-http.test.js");

for (let iteration = 1; iteration <= 50; iteration += 1) {
  const label = `${iteration}/50:tests/gateway-settlement-resolution-http.test.js`;
  process.stdout.write(`\n=== Settlement resolution subprocess ${label} ===\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", abs], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(`\n[50x settlement] FAILED: ${label}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  if (iteration < 50) {
    spawnSync("sleep", ["1"]);
  }
}

process.stdout.write("\nSettlement resolution 50/50 subprocess iterations passed.\n");
