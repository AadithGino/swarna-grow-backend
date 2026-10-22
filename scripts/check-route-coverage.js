import fs from "node:fs";

const expected = new Set(fs.readFileSync(new URL("../docs/contract-routes.lock", import.meta.url), "utf8").trim().split("\n").map((line) => line.replace(/\/$/, "")));
const routeFiles = {
  "admin-config.routes.js": "/admin", "admin-analytics.routes.js": "/admin", "admin-operations.routes.js": "/admin", "admin-schemes.routes.js": "/admin", "admin-ecommerce.routes.js": "/admin", "admin-digital-metals.routes.js": "/admin", "admin-customers.routes.js": "/admin/customers", "assistant.routes.js": "/admin/assistant",
  "staff.routes.js": "/staff", "app.routes.js": "/app", "app-auth.routes.js": "/app/auth", "auth.routes.js": "/auth", "public.routes.js": "/public", "platform.routes.js": "/platform", "webhook.routes.js": "/webhooks",
};
const actual = new Set();
const permissionGatedFiles = new Set([
  "admin-config.routes.js",
  "admin-analytics.routes.js",
  "admin-operations.routes.js",
  "admin-schemes.routes.js",
  "admin-ecommerce.routes.js",
  "admin-digital-metals.routes.js",
  "admin-customers.routes.js",
  "assistant.routes.js",
  "staff.routes.js",
]);
/** Routes that only read/write req.auth.id-scoped data — intentionally ungated on permission. */
const selfServiceAllowlist = new Set([
  "GET /staff/home",
  "GET /staff/dashboard/summary",
  "GET /staff/profile",
  "GET /staff/notifications",
  "POST /staff/devices/fcm-token",
  "DELETE /staff/devices/fcm-token",
]);
const unguarded = [];

for (const [file, prefix] of Object.entries(routeFiles)) {
  const source = fs.readFileSync(new URL(`../src/routes/${file}`, import.meta.url), "utf8");
  for (const match of source.matchAll(/\.\s*(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]([^;]*)\)/gi)) {
    const method = match[1].toUpperCase();
    const path = `${(prefix + match[2]).replace(/\/$/, "")}`;
    actual.add(`${method} ${path}`);
    if (!permissionGatedFiles.has(file)) continue;
    const routeKey = `${method} ${path}`;
    if (selfServiceAllowlist.has(routeKey)) continue;
    const args = match[3] ?? "";
    const hasGuard = /requirePermission\s*\(|guarded\s*\(/.test(args) || /PUBLIC/.test(args);
    if (!hasGuard) unguarded.push(`${routeKey} (${file})`);
  }
}

const indexSource = fs.readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
const adminMountOk = /apiRouter\.use\(\s*["'`]\/admin/.test(indexSource) && /authenticate/.test(indexSource) && /requireSubject\(\s*["'`]TENANT_USER["'`]/.test(indexSource);

const appSource = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
for (const match of appSource.matchAll(/app\.\s*(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi)) actual.add(`${match[1].toUpperCase()} ${match[2].replace(/\/$/, "")}`);

const missing = [...expected].filter((route) => !actual.has(route)).sort();
if (!adminMountOk) {
  process.stderr.write("Admin mount is missing authenticate + requireSubject(\"TENANT_USER\").\n");
  process.exit(1);
}
if (unguarded.length) {
  process.stderr.write(`Unguarded protected routes (${unguarded.length}):\n${unguarded.join("\n")}\n`);
  process.exit(1);
}
if (missing.length) {
  process.stderr.write(`Missing ${missing.length} contract routes:\n${missing.join("\n")}\n`);
  process.exit(1);
}

function routesFromSource(source, prefix) {
  const out = [];
  for (const match of source.matchAll(/\.\s*(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]([^;]*)\)/gi)) {
    const method = match[1].toUpperCase();
    const path = `${(prefix + match[2]).replace(/\/$/, "")}`;
    out.push(`${method} ${path}`);
  }
  return out;
}

/** Digital Metals contract surface must be fully listed in contract-routes.lock. */
const digitalMetalsScoped = [
  ...routesFromSource(
    fs.readFileSync(new URL("../src/routes/admin-digital-metals.routes.js", import.meta.url), "utf8"),
    "/admin",
  ),
  ...routesFromSource(
    fs.readFileSync(new URL("../src/routes/app.routes.js", import.meta.url), "utf8"),
    "/app",
  ).filter((route) => route.includes("/digital-metals/")),
];
const digitalMetalsUndeclared = [...new Set(digitalMetalsScoped)]
  .filter((route) => !expected.has(route))
  .sort();
if (digitalMetalsUndeclared.length) {
  process.stderr.write(
    `Undeclared digital-metals contract routes (${digitalMetalsUndeclared.length}):\n${digitalMetalsUndeclared.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(`Route coverage passed for ${expected.size} applicable contract routes.\n`);
