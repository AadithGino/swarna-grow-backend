import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const adminRoutesPath = path.join(root, "src/routes/admin-digital-metals.routes.js");

test("route coverage fails when a digital-metals route is missing from contract-routes.lock", () => {
  const adminRoutes = fs.readFileSync(adminRoutesPath, "utf8");
  const phantom = '\nadminDigitalMetalsRouter.get(\n  "/digital-metals/__coverage_probe__",\n  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(async () => {})),\n);\n';
  fs.writeFileSync(adminRoutesPath, adminRoutes + phantom);
  try {
    const result = spawnSync(process.execPath, ["scripts/check-route-coverage.js"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr ?? "", /Undeclared digital-metals contract routes/);
    assert.match(result.stderr ?? "", /__coverage_probe__/);
  } finally {
    fs.writeFileSync(adminRoutesPath, adminRoutes);
  }
});
