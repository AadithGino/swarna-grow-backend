/**
 * Idempotent ecommerce demo catalog for existing tenants (MEHER, KAIRALI).
 *
 * Default: dry-run (no writes).
 * Apply:  node --env-file=.env scripts/seed-ecommerce-demo.js --apply --allow-demo-data --tenants=MEHER,KAIRALI
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import {
  adminPortalPaths,
  customerPortalPaths,
  runEcommerceDemoSeed,
} from "./lib/ecommerce-demo-seed.js";

function parseArgs(argv) {
  let apply = false;
  let allowDemoData = false;
  let tenants = ["MEHER", "KAIRALI"];
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--allow-demo-data") allowDemoData = true;
    else if (arg.startsWith("--tenants=")) {
      tenants = arg
        .slice("--tenants=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { apply, allowDemoData, tenants, dryRun: !apply };
}

function assertSafeEnvironment(allowDemoData, apply) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: NODE_ENV=production");
  }
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to run: env.NODE_ENV=production");
  }
  const uri = String(process.env.MONGODB_URI ?? env.MONGODB_URI ?? "");
  const prodLike =
    /\bprod\b/i.test(uri)
    || /production/i.test(uri)
    || /\.prod\./i.test(uri);
  if (prodLike) {
    throw new Error(
      "Refusing to run: MONGODB_URI looks like a production database. Use a dev/staging URI.",
    );
  }
  if (apply && !allowDemoData) {
    throw new Error(
      "Refusing to write: pass --allow-demo-data together with --apply to confirm demo catalog writes.",
    );
  }
}

function dbIdentity(uri) {
  try {
    const u = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "https://"));
    const db = u.pathname?.replace(/^\//, "") || "(default)";
    return { host: u.host, database: db.split("?")[0] };
  } catch {
    return { host: "unknown", database: "unknown" };
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`Usage:
  node --env-file=.env scripts/seed-ecommerce-demo.js [--tenants=MEHER,KAIRALI]
  node --env-file=.env scripts/seed-ecommerce-demo.js --apply --allow-demo-data --tenants=MEHER,KAIRALI

Defaults to dry-run. Writes only demo-owned catalog rows (slug demo-ec-{code}-*), demo display tax when tenant has no real tax, pickup when unset, and demo images when storage credentials work. Does not change subscription, operations flags, or non-demo catalog.
`);
    process.exit(0);
  }

  assertSafeEnvironment(parsed.allowDemoData, !parsed.dryRun);
  const uri = process.env.MONGODB_URI ?? env.MONGODB_URI;
  const identity = dbIdentity(uri);

  await connectDatabase();
  try {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: parsed.dryRun ? "dry-run" : "apply",
          nodeEnv: process.env.NODE_ENV ?? env.NODE_ENV,
          database: identity,
          tenantsRequested: parsed.tenants,
        },
        null,
        2,
      )}\n`,
    );

    const summary = await runEcommerceDemoSeed({
      tenantCodes: parsed.tenants,
      dryRun: parsed.dryRun,
      dbLabel: identity.database,
    });

    summary.routes = {
      admin: adminPortalPaths(),
      customerByTenant: Object.fromEntries(
        parsed.tenants.map((code) => [code, customerPortalPaths(code)]),
      ),
    };

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    if (summary.errors.length) {
      process.exitCode = 2;
    } else if (summary.tenants.some((t) => t.skipped || t.taxWarning)) {
      process.exitCode = summary.tenants.every((t) => t.skipped) ? 2 : 0;
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
