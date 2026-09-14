import fs from "node:fs";

const expected = new Set(fs.readFileSync(new URL("../docs/contract-routes.lock", import.meta.url), "utf8").trim().split("\n").map((line) => line.replace(/\/$/, "")));
const routeFiles = {
  "admin-config.routes.js": "/admin", "admin-analytics.routes.js": "/admin", "admin-operations.routes.js": "/admin", "admin-schemes.routes.js": "/admin", "admin-customers.routes.js": "/admin/customers",
  "staff.routes.js": "/staff", "app.routes.js": "/app", "app-auth.routes.js": "/app/auth", "auth.routes.js": "/auth", "public.routes.js": "/public", "platform.routes.js": "/platform", "webhook.routes.js": "/webhooks",
};
const actual = new Set();
for (const [file, prefix] of Object.entries(routeFiles)) {
  const source = fs.readFileSync(new URL(`../src/routes/${file}`, import.meta.url), "utf8");
  for (const match of source.matchAll(/\.\s*(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi)) actual.add(`${match[1].toUpperCase()} ${(prefix + match[2]).replace(/\/$/, "")}`);
}
const appSource = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
for (const match of appSource.matchAll(/app\.\s*(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi)) actual.add(`${match[1].toUpperCase()} ${match[2].replace(/\/$/, "")}`);
const missing = [...expected].filter((route) => !actual.has(route)).sort();
if (missing.length) { process.stderr.write(`Missing ${missing.length} contract routes:\n${missing.join("\n")}\n`); process.exitCode = 1; }
else process.stdout.write(`Route coverage passed for ${expected.size} applicable contract routes.\n`);

