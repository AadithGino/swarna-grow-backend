import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendRootDefault = path.resolve(backendRoot, "../SwarnaGrow-Tenant-Admin");
const isolatedFrontendRoot = path.join(backendRoot, ".phase1-isolated/frontend-runtime");
const frontendBase = process.env.FRONTEND_BASE ?? "http://localhost:3123";
const apiBase = process.env.API_BASE ?? "http://127.0.0.1:4051/api/v1";
const API_PORT = 4051;
const FRONTEND_PORT = 3123;

function listPortListeners(port) {
  try {
    const out = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" }).trim();
    return out ? out.split("\n").filter(Boolean).map(Number) : [];
  } catch {
    return [];
  }
}

async function waitForHttp(url, timeoutMs = 120_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url, { redirect: "manual" });
        if (res.status < 500) return resolve(res.status);
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for ${url}`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function verifyPhase1ApiIdentity() {
  const res = await fetch(`${apiBase}/public/tenants/resolve?tenantCode=PHASE1A`);
  if (res.status >= 500) throw new Error(`Phase 1 API not ready (status ${res.status})`);
  const body = await res.json();
  if (!body?.success || !body?.data?.tenants?.length) {
    throw new Error("Phase 1 API resolve probe failed (expected PHASE1A tenant)");
  }
}

async function verifyFrontendLiveApiBinding(label) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const apiRequests = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/v1/")) apiRequests.push(url);
    });
    const resolveUrl = `${apiBase}/public/tenants/resolve?tenantCode=PHASE1A`;
    await page.goto(`${frontendBase}/customer/phase1a/login`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await page.waitForRequest(
      (req) => req.url().startsWith(resolveUrl) || req.url().includes("/public/tenants/resolve"),
      { timeout: 45_000 },
    ).catch(async () => {
      await page.goto(`${frontendBase}/customer/phase1a/home`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
      await page.waitForRequest(
        (req) => req.url().includes("/public/tenants/resolve"),
        { timeout: 45_000 },
      );
    });
    await page.waitForTimeout(1_500);
    const html = await page.content();
    if (/NEXT_PUBLIC_USE_MOCKS\s*=\s*true/i.test(html) || html.includes('"useMocks":true')) {
      throw new Error(`${label}: frontend indicates mocks are enabled`);
    }
    const apiPort = new URL(apiBase).port || "4051";
    const apiHost = new URL(apiBase).hostname;
    const sawIsolatedApi = apiRequests.some(
      (url) => url.includes(`:${apiPort}`) || url.includes(`${apiHost}:${apiPort}`),
    );
    const strayDefaultApi = apiRequests.some(
      (url) => /:4000\/api\/v1\//.test(url) && apiPort !== "4000",
    );
    if (strayDefaultApi) {
      throw new Error(`${label}: observed traffic to wrong API origin (:4000)`);
    }
    if (!sawIsolatedApi) {
      throw new Error(
        `${label}: expected application /api/v1 traffic to ${apiHost}:${apiPort}, saw ${apiRequests.length} request(s)`,
      );
    }
  } finally {
    await browser.close();
  }
}

async function verifyReuseFrontendBinding() {
  await verifyFrontendLiveApiBinding("reuse probe");
}

function syncIsolatedFrontendRuntime() {
  fs.mkdirSync(path.dirname(isolatedFrontendRoot), { recursive: true });
  const excludes = [
    "node_modules/",
    ".git/",
    ".next/",
    ".vinext/",
    ".wrangler/",
    ".phase1-isolated/",
  ];
  const args = ["-a", "--delete", ...excludes.flatMap((x) => ["--exclude", x]), `${frontendRootDefault}/`, `${isolatedFrontendRoot}/`];
  execFileSync("rsync", args, { stdio: ["ignore", "pipe", "pipe"] });
  const linkTarget = path.join(frontendRootDefault, "node_modules");
  const linkPath = path.join(isolatedFrontendRoot, "node_modules");
  if (!fs.existsSync(linkPath)) {
    fs.symlinkSync(linkTarget, linkPath, "dir");
  }
  process.stdout.write(`Phase 1 isolated frontend runtime: ${isolatedFrontendRoot}\n`);
  return isolatedFrontendRoot;
}

function frontendRootForOwnedSpawn() {
  if (process.env.PHASE1_FRONTEND_ROOT) {
    return path.resolve(process.env.PHASE1_FRONTEND_ROOT);
  }
  return syncIsolatedFrontendRuntime();
}

const ownedChildren = [];

function trackChild(child, label) {
  ownedChildren.push({ child, label, pid: child.pid });
  child.on("error", (err) => {
    process.stderr.write(`Spawn error (${label}): ${err.message}\n`);
  });
  return child;
}

async function waitForProcessExit(child, timeoutMs = 10_000) {
  if (child.exitCode != null) return child.exitCode;
  return Promise.race([
    once(child, "close").then(([code]) => code ?? 1),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

async function terminateOwnedChild(entry, signal = "SIGTERM") {
  const { child, label } = entry;
  if (child.exitCode != null || child.killed) return;
  try {
    process.kill(child.pid, signal);
  } catch {
    /* already gone */
  }
  const code = await waitForProcessExit(child, 12_000);
  if (code === null) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    await waitForProcessExit(child, 5_000);
  }
  process.stderr.write(`Stopped ${label} (pid ${child.pid})\n`);
}

async function cleanupOwnedChildren() {
  const closing = ownedChildren.splice(0).map((entry) => terminateOwnedChild(entry));
  await Promise.all(closing);
}

let shuttingDown = false;
async function onInterrupt() {
  if (shuttingDown) return;
  shuttingDown = true;
  await cleanupOwnedChildren();
  process.exit(130);
}
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

async function assertPortsAvailableForSpawn() {
  if (process.env.PHASE1_REUSE_VERIFIED_SERVICES === "1") {
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Reuse mode requires browser fixture at ${fixturePath}`);
    }
    await verifyPhase1ApiIdentity();
    await waitForHttp(`${frontendBase}/customer/phase1a/login`, 15_000);
    await verifyReuseFrontendBinding();
    process.stdout.write("Reusing verified Phase 1 services\n");
    return { api: null, frontend: null, reused: true };
  }
  const occupied = [];
  for (const port of [API_PORT, FRONTEND_PORT]) {
    const pids = listPortListeners(port);
    if (pids.length) occupied.push({ port, pids });
  }
  if (occupied.length) {
    const detail = occupied.map((o) => `${o.port} (PIDs: ${o.pids.join(", ")})`).join("; ");
    throw new Error(
      `Phase 1 browser gate cannot start: port(s) already in use: ${detail}. `
      + "Stop unrelated listeners or set PHASE1_REUSE_VERIFIED_SERVICES=1 only after verifying Phase 1 API health and browser fixture routes.",
    );
  }
  return { api: null, frontend: null, reused: false };
}

const fixturePath = path.join(backendRoot, "evidence/remediation/phase1-browser-fixture.json");

async function waitForBrowserFixture(timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(fixturePath)) {
      try {
        JSON.parse(fs.readFileSync(fixturePath, "utf8"));
        return;
      } catch {
        /* seed in progress */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Phase 1 browser fixture was not written to ${fixturePath}`);
}

const portState = await assertPortsAvailableForSpawn();

try {
  if (!portState.reused) {
    const api = trackChild(
      spawn("node", ["scripts/phase1-remediation-api-server.js"], {
        cwd: backendRoot,
        env: { ...process.env, NODE_ENV: "test", PORT: String(API_PORT) },
        stdio: ["ignore", "pipe", "inherit"],
        detached: false,
      }),
      `phase1 API :${API_PORT}`,
    );
    api.stdout?.on("data", (buf) => process.stdout.write(buf));

    let apiReady = false;
    for (let i = 0; i < 240 && !apiReady; i += 1) {
      try {
        await verifyPhase1ApiIdentity();
        apiReady = true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!apiReady) throw new Error("Phase 1 API server did not become ready");
    await waitForBrowserFixture();
    process.stdout.write(`Browser fixture ready at ${fixturePath}\n`);

    const ownedFrontendRoot = frontendRootForOwnedSpawn();
    const vinextCli = path.join(ownedFrontendRoot, "node_modules/vinext/dist/cli.js");
    const frontend = trackChild(
      spawn(
        process.execPath,
        [vinextCli, "dev", "--port", String(FRONTEND_PORT), "--host", "localhost"],
        {
          cwd: ownedFrontendRoot,
          env: {
            ...process.env,
            NEXT_PUBLIC_USE_MOCKS: "false",
            NEXT_PUBLIC_API_BASE_URL: apiBase,
            NEXT_PUBLIC_CUSTOMER_TENANT_CODE: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
      `frontend dev :${FRONTEND_PORT}`,
    );
    frontend.stdout?.on("data", (buf) => process.stdout.write(buf));
    frontend.stderr?.on("data", (buf) => process.stderr.write(buf));

    const frontendReady = waitForHttp(`${frontendBase}/customer/phase1a/login`, 180_000);
    const frontendFailed = once(frontend, "close").then(([code]) => {
      throw new Error(`Frontend dev exited before ready (code ${code ?? "unknown"})`);
    });
    await Promise.race([frontendReady, frontendFailed]);
    await verifyFrontendLiveApiBinding("owned probe");
    process.stdout.write(`Frontend ready at ${frontendBase}\n`);
  }

  const browserScript = path.join(backendRoot, "scripts/phase1-customer-identity.browser.cjs");
  const browserRun = trackChild(
    spawn("node", [browserScript], {
      cwd: backendRoot,
      env: {
        ...process.env,
        FRONTEND_BASE: frontendBase,
        API_BASE: apiBase,
        PHASE1_BROWSER_FIXTURE: fixturePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    "phase1 browser script",
  );
  browserRun.stdout?.on("data", (buf) => process.stdout.write(buf));
  browserRun.stderr?.on("data", (buf) => process.stderr.write(buf));

  const exitCode = await new Promise((resolve) => browserRun.on("close", resolve));
  process.exitCode = exitCode ?? 1;
} finally {
  if (!portState.reused) {
    await cleanupOwnedChildren();
  }
}
process.exit(process.exitCode ?? 1);
