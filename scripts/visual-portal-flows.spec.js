import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const FRONTEND_BASE = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const API_BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const OUT_DIR =
  process.env.VISUAL_E2E_OUT_DIR ??
  "/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend/docs/e2e-visual-screenshots/flows";
const RESULT_PATH =
  "/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend/docs/e2e-visual-flow-results.json";

fs.mkdirSync(OUT_DIR, { recursive: true });

const RESULTS = [];

const REPORTS = [
  ["COLLECTION", "Collection"],
  ["ENROLMENT", "Enrolment"],
  ["OUTSTANDING", "Outstanding"],
  ["MATURITY_REDEMPTION", "Maturity"],
  ["GOLD_ACCRUAL", "Gold accrual"],
  ["CUSTOMER_PERFORMANCE", "Customer performance"],
  ["STAFF_PERFORMANCE", "Staff performance"],
  ["CASH_HANDOVER", "Cash handover"],
  ["REMINDER_DELIVERY", "Reminder delivery"],
  ["WHATSAPP_USAGE", "WhatsApp"],
  ["SCHEME_REGISTER", "Scheme register"],
  ["DEFAULTER", "Defaulter"],
  ["BRANCH_PERFORMANCE", "Branch performance"],
  ["SCHEME_PERFORMANCE", "Scheme performance"],
];

const TENANT_PAGES = [
  ["/", "dashboard"],
  ["/customers", "customers"],
  ["/enrollments", "enrollments"],
  ["/dues", "dues"],
  ["/collections", "collections"],
  ["/cash-control", "cash-control"],
  ["/maturity", "maturity"],
  ["/gold-rates", "gold-rates"],
  ["/reminders", "reminders"],
  ["/support", "support"],
  ["/schemes", "schemes"],
  ["/schemes/new", "scheme-builder"],
  ["/staff-branches", "staff-branches"],
  ["/audit", "audit"],
  ["/alerts", "alerts"],
  ["/settings", "settings"],
  ["/settings/operations", "settings-operations"],
  ["/settings/subscription", "settings-subscription"],
  ["/settings/branding", "settings-branding"],
  ["/settings/profile", "settings-profile"],
];

function record(entry) {
  RESULTS.push(entry);
  fs.writeFileSync(RESULT_PATH, JSON.stringify(RESULTS, null, 2));
}

function finish(scope) {
  const failed = RESULTS.filter((row) => row.scope === scope && !row.ok);
  expect(failed, failed.map((row) => `${row.label}: ${row.reason ?? "failed"}`).join("\n")).toEqual([]);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, name), fullPage: true });
}

async function openHydrated(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
}

async function fillControlled(locator, value) {
  await locator.waitFor({ state: "visible" });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await locator.click();
    await locator.fill(value);
    if ((await locator.inputValue()) === value) return;
    await locator.page().waitForTimeout(400);
  }
  throw new Error(`Input did not keep value "${value}"`);
}

async function pageHealthy(page) {
  const text = await page.locator("body").innerText({ timeout: 20000 });
  const crashed = /application error: a |unhandled runtime error|this page could not be found/i.test(text);
  return { text, crashed };
}

async function visit(page, scope, label, url, { screenshot = false } = {}) {
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(700);
    const { text, crashed } = await pageHealthy(page);
    const landed = page.url();
    const bounced = /\/login/.test(landed) && !url.includes("/login");
    if (crashed || bounced) {
      record({
        scope,
        label,
        url,
        ok: false,
        reason: crashed ? "page error" : `bounced to ${landed}`,
        ms: Date.now() - started,
      });
      return { ok: false, text };
    }
    if (screenshot) await shot(page, `${scope}-${label}.png`);
    record({ scope, label, url: landed, ok: true, ms: Date.now() - started });
    return { ok: true, text };
  } catch (error) {
    record({
      scope,
      label,
      url,
      ok: false,
      reason: String(error?.message ?? error).slice(0, 240),
      ms: Date.now() - started,
    });
    return { ok: false, text: "" };
  }
}

async function tenantLogin(page, { mobile, password, tenantCode }) {
  await openHydrated(page, `${FRONTEND_BASE}/login`);
  await fillControlled(page.locator('input[autocomplete="username"]').first(), mobile);
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), password);
  await fillControlled(page.locator('input[autocomplete="organization"]').first(), tenantCode);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
}

async function customerLogin(page, slug, mobile, mode) {
  await page.goto(`${FRONTEND_BASE}/customer/${slug}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#mobile").waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#mobile").fill(mobile);
  if (mode === "PASSWORD") {
    await page.locator("#password").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#password").fill("2026");
    await page.getByRole("button", { name: "Sign in" }).last().click();
  } else {
    await page.getByRole("button", { name: "Send secure OTP" }).click();
    await page.locator("#otp").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#otp").fill("123456");
    await page.getByRole("button", { name: "Verify & continue" }).click();
  }
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 25000 });
}

function rowsFrom(json) {
  const data = json?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(json?.items)) return json.items;
  return [];
}

async function authedGet(page, tokenKey, apiPath) {
  const token = await page.evaluate((key) => localStorage.getItem(key), tokenKey);
  const rows = [];
  let cursor = null;
  let status = 0;
  for (let pageNo = 0; pageNo < 8; pageNo += 1) {
    const url = new URL(`${API_BASE}${apiPath}`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await page.request.get(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    status = response.status();
    const json = await response.json().catch(() => ({}));
    if (status !== 200) return { status, json, rows };
    rows.push(...rowsFrom(json));
    cursor = json?.data?.meta?.nextCursor ?? json?.meta?.nextCursor ?? null;
    if (!cursor) break;
  }
  return { status, rows };
}

test("tenant admin feature and flow click-run", async ({ browser }) => {
  test.setTimeout(8 * 60 * 1000);
  const scope = "tenant-kairali";
  const context = await browser.newContext();
  const page = await context.newPage();
  await tenantLogin(page, { mobile: "9847012345", password: "2026", tenantCode: "KAIRALI" });
  record({ scope, label: "login", ok: true });

  for (const [route, label] of TENANT_PAGES) {
    await visit(page, scope, label, `${FRONTEND_BASE}${route}`, { screenshot: true });
  }
  for (const [key, label] of REPORTS) {
    const result = await visit(page, scope, `report-${key}`, `${FRONTEND_BASE}/reports?reportKey=${key}`);
    if (result.ok && !result.text.toLowerCase().includes(label.toLowerCase().split(" ")[0])) {
      record({ scope, label: `report-text-${key}`, ok: false, reason: `missing "${label}"` });
    }
  }

  await page.goto(`${FRONTEND_BASE}/customers`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const customerRow = page.locator("tbody tr").first();
  if (await customerRow.count()) {
    await customerRow.click();
    await page.waitForURL(/\/customers\/[^/]+$/, { timeout: 15000 });
    for (const tab of ["Schemes", "Contributions", "Messages", "Customer", "Activity & audit"]) {
      await page.getByRole("tab", { name: tab }).click();
      await page.waitForTimeout(400);
      const { crashed } = await pageHealthy(page);
      record({ scope, label: `customer-tab-${tab}`, ok: !crashed, reason: crashed ? "page error" : undefined });
    }
    await shot(page, "tenant-customer-detail.png");
  } else {
    record({ scope, label: "customer-detail", ok: false, reason: "no customer rows" });
  }

  const schemes = await authedGet(page, "swarnagrow.accessToken", "/admin/schemes");
  const schemeRows = schemes.rows.map((row) => ({
    id: row.id ?? row._id,
    status: row.status,
    valueBasis: row.valueBasis ?? row.planSnapshot?.valueBasis,
    pattern: row.paymentPattern ?? row.planSnapshot?.paymentPattern,
    name: row.planName ?? row.planSnapshot?.name ?? row.enrollmentNumber,
  }));
  record({
    scope,
    label: "scheme-list-api",
    ok: schemes.status === 200 && schemeRows.length > 0,
    reason: schemes.status === 200 ? `count=${schemeRows.length}` : `status ${schemes.status}`,
  });

  const picks = [];
  const wanted = [
    (row) => row.pattern === "FIXED" && row.valueBasis === "CASH" && row.status === "ACTIVE",
    (row) => row.pattern === "FLEXIBLE" && row.status === "LOCKED",
    (row) => row.valueBasis === "GOLD_WEIGHT" && row.status === "MATURED",
    (row) => row.valueBasis === "GOLD_WEIGHT" && row.status === "ACTIVE",
    (row) => row.status === "DEFAULTED",
    (row) => row.status === "REDEEMED",
  ];
  for (const match of wanted) {
    const found = schemeRows.find((row) => row.id && match(row) && !picks.some((picked) => picked.id === row.id));
    if (found) picks.push(found);
  }
  if (!picks.length && schemeRows[0]) picks.push(schemeRows[0]);

  for (const scheme of picks) {
    const opened = await visit(page, scope, `enrollment-${scheme.status}-${scheme.valueBasis}`, `${FRONTEND_BASE}/enrollments/${scheme.id}`);
    if (!opened.ok) continue;
    for (const tab of ["Schedule", "Payment ledger", "Maturity", "Timeline"]) {
      const tabButton = page.getByRole("tab", { name: tab });
      if (await tabButton.count()) {
        await tabButton.click();
        await page.waitForTimeout(300);
      }
    }
    const preview = page.getByRole("button", { name: "Settlement preview" });
    if (await preview.count() && await preview.isEnabled()) {
      await preview.click();
      await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      const dialog = page.getByRole("dialog");
      if (await dialog.count()) {
        const combo = dialog.getByRole("combobox");
        if (await combo.count()) {
          await combo.click();
          const optionNames = await page.getByRole("option").allInnerTexts();
          await page.keyboard.press("Escape");
          for (const mode of optionNames) {
            await dialog.getByRole("combobox").click();
            await page.getByRole("option", { name: mode, exact: true }).click();
            await page.waitForTimeout(500);
            const note = await dialog.innerText();
            record({
              scope,
              label: `settlement-${scheme.status}-${mode}`,
              ok: !/could not load settlement preview/i.test(note),
              reason: /could not load settlement preview/i.test(note) ? "preview error" : undefined,
            });
          }
        } else {
          record({ scope, label: `settlement-${scheme.status}-single`, ok: true });
        }
        await shot(page, `tenant-settlement-${scheme.status}.png`);
        await page.keyboard.press("Escape");
      } else {
        record({ scope, label: `settlement-open-${scheme.id}`, ok: false, reason: "dialog did not open" });
      }
    }
  }

  await context.close();
  finish(scope);
});

test("matrix scheme type and status click-run", async ({ browser }) => {
  test.setTimeout(10 * 60 * 1000);
  const scope = "matrixcore";
  const context = await browser.newContext();
  const page = await context.newPage();
  await tenantLogin(page, { mobile: "9799999901", password: "2026", tenantCode: "MATRIXCORE" });
  record({ scope, label: "owner-login", ok: true });

  const listed = await authedGet(page, "swarnagrow.accessToken", "/admin/schemes");
  const schemes = listed.rows
    .map((row) => ({
      id: row.id ?? row._id,
      status: row.status,
      name: row.planName ?? row.planSnapshot?.displayName ?? row.planSnapshot?.name ?? "",
      valueBasis: row.valueBasis,
    }))
    .filter((row) => row.id);
  record({
    scope,
    label: "scheme-matrix-count",
    ok: listed.status === 200 && schemes.length >= 40,
    reason: `status=${listed.status} count=${schemes.length}`,
  });

  const seen = new Set();
  for (const scheme of schemes) {
    const key = `${scheme.name}|${scheme.status}`;
    const result = await visit(
      page,
      scope,
      `scheme-${scheme.status}-${scheme.name || scheme.id}`,
      `${FRONTEND_BASE}/enrollments/${scheme.id}`,
    );
    if (result.ok) seen.add(key);
  }
  record({ scope, label: "distinct-type-status-pages", ok: seen.size >= 40, reason: `rendered=${seen.size}` });
  await context.close();

  const customer = await browser.newContext();
  const customerPage = await customer.newPage();
  await customerLogin(customerPage, "matrixcore", "9799999902", "OTP");
  record({ scope, label: "customer-login", ok: true });
  await visit(customerPage, scope, "customer-home", `${FRONTEND_BASE}/customer/matrixcore`, { screenshot: true });
  await visit(customerPage, scope, "customer-schemes", `${FRONTEND_BASE}/customer/matrixcore/schemes`, { screenshot: true });
  const pastTab = customerPage.getByRole("button", { name: /past/i });
  if (await pastTab.count()) {
    await pastTab.click();
    await customerPage.waitForTimeout(500);
  }
  const links = await customerPage.locator('a[href*="/customer/matrixcore/schemes/"]').evaluateAll((nodes) =>
    [...new Set(nodes.map((node) => node.getAttribute("href")).filter(Boolean))],
  );
  const active = await authedGet(customerPage, "swarnagrow.customer.accessToken", "/app/schemes");
  const past = await authedGet(customerPage, "swarnagrow.customer.accessToken", "/app/schemes?group=PAST");
  const pending = await authedGet(customerPage, "swarnagrow.customer.accessToken", "/app/schemes?status=PENDING_PAYMENT");
  const expired = await authedGet(customerPage, "swarnagrow.customer.accessToken", "/app/schemes?status=ENROLMENT_EXPIRED");
  const ids = [...active.rows, ...past.rows, ...pending.rows, ...expired.rows]
    .map((row) => row.id ?? row._id)
    .filter(Boolean);
  const targets = ids.length ? ids : links.map((href) => href.split("/").pop());
  record({
    scope,
    label: "customer-scheme-ids",
    ok: targets.length > 0,
    reason: `count=${targets.length}`,
  });
  for (const id of targets) {
    const href = String(id).startsWith("/") ? `${FRONTEND_BASE}${id}` : `${FRONTEND_BASE}/customer/matrixcore/schemes/${id}`;
    await visit(customerPage, scope, `customer-scheme-${id}`, href);
  }
  await customer.close();
  finish(scope);
});

test("customer portal business flows", async ({ browser }) => {
  test.setTimeout(8 * 60 * 1000);
  const scope = "customer-kairali";
  const people = [
    ["lakshmi", "9847123456"],
    ["flexi", "9847901234"],
    ["gold", "9847934567"],
  ];
  const routes = [
    ["", "home"],
    ["schemes", "schemes"],
    ["payments", "payments"],
    ["notifications", "notifications"],
    ["profile", "profile"],
    ["profile/nominee", "nominee"],
    ["profile/kyc", "kyc"],
    ["security", "security"],
    ["support", "support"],
    ["gold-rate", "gold-rate"],
    ["branches", "branches"],
    ["plans", "plans"],
  ];

  for (const [name, mobile] of people) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await customerLogin(page, "kairali", mobile, "OTP");
    record({ scope, label: `${name}-login`, ok: true });
    for (const [route, label] of routes) {
      await visit(
        page,
        scope,
        `${name}-${label}`,
        route ? `${FRONTEND_BASE}/customer/kairali/${route}` : `${FRONTEND_BASE}/customer/kairali`,
        { screenshot: label === "home" || label === "schemes" },
      );
    }
    await page.goto(`${FRONTEND_BASE}/customer/kairali/schemes`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const schemeLinks = await page.locator('a[href*="/customer/kairali/schemes/"]').evaluateAll((nodes) =>
      [...new Set(nodes.map((node) => node.getAttribute("href")).filter(Boolean))],
    );
    record({ scope, label: `${name}-scheme-cards`, ok: schemeLinks.length > 0, reason: `count=${schemeLinks.length}` });
    for (const href of schemeLinks.slice(0, 4)) {
      await page.goto(`${FRONTEND_BASE}${href}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      const { crashed, text } = await pageHealthy(page);
      record({
        scope,
        label: `${name}-scheme-${href.split("/").pop()}`,
        ok: !crashed && !page.url().includes("/login"),
        reason: crashed ? "page error" : undefined,
      });
      const pay = page.getByRole("button", { name: /^(Pay |Add payment)/ });
      if (await pay.count() && await pay.first().isEnabled()) {
        await pay.first().click();
        const sheet = page.getByRole("dialog");
        const opened = await sheet.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
        record({ scope, label: `${name}-pay-sheet`, ok: opened, reason: opened ? undefined : "payment sheet did not open" });
        if (opened) {
          await shot(page, `${name}-payment-sheet.png`);
          await page.keyboard.press("Escape");
        }
      }
      const redeem = page.getByRole("button", { name: "Request redemption" });
      if (await redeem.count() && await redeem.first().isEnabled()) {
        await redeem.first().click();
        const dialog = page.getByRole("dialog");
        const opened = await dialog.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
        record({ scope, label: `${name}-redeem-dialog`, ok: opened, reason: opened ? undefined : "redeem dialog did not open" });
        if (opened) {
          const combo = dialog.getByRole("combobox");
          if (await combo.count()) {
            await combo.click();
            const options = page.getByRole("option");
            const count = await options.count();
            for (let index = 0; index < count; index += 1) {
              if (index > 0) await dialog.getByRole("combobox").click();
              const option = page.getByRole("option").nth(index);
              const optionName = await option.innerText();
              await option.click();
              await page.waitForTimeout(400);
              record({ scope, label: `${name}-redeem-mode-${optionName}`, ok: true });
            }
          }
          await shot(page, `${name}-redemption.png`);
          await page.keyboard.press("Escape");
        }
      }
      if (/could not load|application error/i.test(text)) {
        record({ scope, label: `${name}-scheme-body`, ok: false, reason: "error text on scheme" });
      }
    }
    await context.close();
  }
  finish(scope);
});

test("agent portal collect history and account click-run", async ({ browser }) => {
  test.setTimeout(4 * 60 * 1000);
  const scope = "agent-kairali";
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${FRONTEND_BASE}/agent/kairali/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#agent-mobile").fill("9847012352");
  await page.locator("#agent-password").fill("2026");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
  record({ scope, label: "login", ok: true });

  for (const [route, label] of [
    ["/agent", "home"],
    ["/agent/collect", "collect"],
    ["/agent/history", "history"],
    ["/agent/handover", "handover"],
    ["/agent/report", "report"],
    ["/agent/account", "account"],
  ]) {
    await visit(page, scope, label, `${FRONTEND_BASE}${route}`, { screenshot: true });
  }

  await page.goto(`${FRONTEND_BASE}/agent/collect`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const search = page.getByPlaceholder("Name, mobile, customer no. or passbook");
  if (await search.count()) {
    await search.fill("9847234567");
    await page.waitForTimeout(1200);
  }
  const customerLink = page.locator('a[href*="/agent/customers/"]').first();
  if (await customerLink.count()) {
    await customerLink.click();
    await page.waitForURL(/\/agent\/customers\//, { timeout: 15000 });
    await page.getByText("What are you collecting for?").waitFor({ timeout: 15000 });
    record({ scope, label: "customer-detail", ok: true, url: page.url() });
    await shot(page, "agent-customer.png");
    const schemeLink = page.locator('a[href*="/agent/collect/"]').first();
    if (await schemeLink.count()) {
      await schemeLink.click();
      await page.waitForTimeout(900);
      const { text, crashed } = await pageHealthy(page);
      const ready = /enter amount received/i.test(text);
      record({
        scope,
        label: "collect-form",
        ok: !crashed && ready,
        reason: ready ? undefined : "collect form did not render",
      });
      await shot(page, "agent-collect-form.png");
    } else {
      record({ scope, label: "collect-form", ok: false, reason: "no scheme collect link" });
    }
  } else {
    record({ scope, label: "customer-search", ok: false, reason: "no customers in collector branch" });
  }
  await context.close();
  finish(scope);
});

test("platform portal surface click-run", async ({ browser }) => {
  test.setTimeout(4 * 60 * 1000);
  const scope = "platform";
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHydrated(page, `${FRONTEND_BASE}/platform/login`);
  await fillControlled(page.locator('input[type="email"]').first(), "ops@platform.com");
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "1234");
  await expect(page.getByRole("button", { name: "Sign in securely" })).toBeEnabled();
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
  record({ scope, label: "login", ok: true });

  for (const [route, label] of [
    ["/platform", "overview"],
    ["/platform/tenants", "tenants"],
    ["/platform/tenants/new", "tenant-create"],
    ["/platform/plans", "plans"],
    ["/platform/templates", "templates"],
    ["/platform/monitoring", "monitoring"],
    ["/platform/audit", "audit"],
    ["/platform/settings", "settings"],
  ]) {
    await visit(page, scope, label, `${FRONTEND_BASE}${route}`, { screenshot: true });
  }

  await page.goto(`${FRONTEND_BASE}/platform/tenants`, { waitUntil: "domcontentloaded" });
  const tenantRow = page.locator("tbody tr").first();
  try {
    await tenantRow.waitFor({ state: "visible", timeout: 15000 });
    await tenantRow.click();
    await page.waitForURL(/\/platform\/tenants\/(?!new$)[^/]+/, { timeout: 15000 });
    await page.waitForTimeout(800);
    const { crashed } = await pageHealthy(page);
    record({
      scope,
      label: "tenant-detail",
      ok: !crashed,
      url: page.url(),
      reason: crashed ? "page error" : undefined,
    });
    await shot(page, "platform-tenant-detail.png");
  } catch (error) {
    record({
      scope,
      label: "tenant-detail",
      ok: false,
      reason: String(error?.message ?? error).slice(0, 180),
    });
  }
  await context.close();
  finish(scope);
});

test("operations combination customer portals", async ({ browser }) => {
  test.setTimeout(45 * 60 * 1000);
  const scope = "ops-combinations";
  for (let index = 0; index < 128; index += 1) {
    const code = `OPS${String(index + 1).padStart(3, "0")}`;
    const slug = code.toLowerCase();
    const mobile = String(9700000500 + index);
    const mode = index % 2 === 0 ? "OTP" : "PASSWORD";
    const paymentsEnabled = Math.floor(index / 16) % 2 === 0;
    const writeEnabled = Math.floor(index / 32) % 2 === 0;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await customerLogin(page, slug, mobile, mode);
      const home = await visit(page, scope, `${code}-home`, `${FRONTEND_BASE}/customer/${slug}`);
      const schemes = await visit(page, scope, `${code}-schemes`, `${FRONTEND_BASE}/customer/${slug}/schemes`);
      record({
        scope,
        label: `${code}-combo`,
        ok: home.ok && schemes.ok,
        reason: `login=${mode} payments=${paymentsEnabled} write=${writeEnabled}`,
      });
    } catch (error) {
      record({
        scope,
        label: `${code}-login`,
        ok: false,
        reason: `${mode}: ${String(error?.message ?? error).slice(0, 180)}`,
      });
    }
    await context.close();
  }
  finish(scope);
});
