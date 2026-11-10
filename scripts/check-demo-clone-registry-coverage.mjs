#!/usr/bin/env node
/**
 * CI gate for the Demo Builder's clone policy registry (plan section 5.2).
 *
 * Fails (exit 1) when a tenant-scoped Mongoose model has no COPY/REBUILD/SYNTHETIC/EXCLUDE
 * decision in src/lib/demo-clone-registry.js. Run this in CI whenever src/models changes, the
 * same way scripts/check-route-coverage.js already gates routes.
 *
 * Does not touch the database — only loads schemas.
 *
 * Usage:
 *   node scripts/check-demo-clone-registry-coverage.mjs
 */
import "../src/models/index.js";
import { findUnregisteredTenantScopedModels } from "../src/lib/demo-clone-registry.js";

const missing = findUnregisteredTenantScopedModels();

if (missing.length) {
  console.error("Demo clone registry coverage FAILED.");
  console.error("The following tenant-scoped models have no entry in src/lib/demo-clone-registry.js:");
  for (const name of missing) console.error(`  - ${name}`);
  console.error(
    "\nAdd a COPY, REBUILD, SYNTHETIC or EXCLUDE entry with a rationale for each, or add the " +
      "name to NOT_TENANT_SCOPED/DEMO_CONTROL_PLANE_MODELS if it is deliberately out of scope.",
  );
  process.exit(1);
}

console.log("Demo clone registry coverage OK — every tenant-scoped model has a declared policy.");
process.exit(0);
