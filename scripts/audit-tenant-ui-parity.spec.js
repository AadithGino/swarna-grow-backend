/**
 * Full KAIRALI tenant UI parity: every screen/tab, KPI cards vs API, reports, reminders, gap actions.
 *
 * Run: npm run test:tenant-ui-parity
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  REPORT_KEYS,
  TENANT_ROUTES,
  bodyIncludesValue,
  bodyIncludesMoneyRef,
} from "./lib/parity-display.js";

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const API = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const ROOT = path.resolve(".");
const OUT = path.join(ROOT, "docs/tenant-ui-parity-results.json");
const REPORT_CONTRACT = path.join(ROOT, "docs/tenant-report-kpi-contract.json");

const findings = [];
function record(area, ok, detail) {
  findings.push({ area, ok, detail });
  fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));
}

async function step(area, fn) {
  try {
    record(area, true, await fn());
  } catch (error) {
    record(
      area,
      false,
      String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 500),
    );
  }
}

async function fill(locator, value) {
  await locator.scrollIntoViewIfNeeded();
  for (let i = 0; i < 4; i += 1) {
    await locator.click();
    await locator.fill(String(value));
    if ((await locator.inputValue()) === String(value)) return;
    await locator.page().waitForTimeout(250);
  }
  await locator.fill(String(value));
  if ((await locator.inputValue()) !== String(value)) {
    throw new Error(`Could not fill field with ${String(value).slice(0, 8)}…`);
  }
}

async function login(page) {
  await page.goto(`${FRONTEND}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await fill(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fill(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fill(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 25000 });
}

async function token(page) {
  return page.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
}

async function apiGet(page, apiPath) {
  const t = await token(page);
  const res = await page.request.get(`${API}${apiPath}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  const json = await res.json().catch(() => ({}));
  const data = json?.data;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return { status: res.status(), rows, json, meta: json?.meta, data };
}

function monthRangeQuery() {
  const today = new Date().toISOString().slice(0, 10);
  const from = `${today.slice(0, 7)}-01`;
  return `from=${from}&to=${today}`;
}

test.use({ actionTimeout: 20000, navigationTimeout: 30000 });

test("KAIRALI tenant UI parity — screens, KPIs, reports, reminders, actions", async ({
  page,
}) => {
  test.setTimeout(25 * 60 * 1000);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, "[]");

  execFileSync("npm", ["run", "seed:pending-handover"], { cwd: ROOT, stdio: "pipe" });
  execFileSync("npm", ["run", "seed:tenant-coverage-gaps"], { cwd: ROOT, stdio: "pipe" });
  execFileSync("node", ["--env-file=.env", "scripts/audit-tenant-report-kpi-contract.js"], {
    cwd: ROOT,
    stdio: "pipe",
  });

  await login(page);

  await step("screens-all-routes", async () => {
    const crashed = [];
    for (const [route, label] of TENANT_ROUTES) {
      await page.goto(`${FRONTEND}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(400);
      const text = await page.locator("body").innerText();
      if (/application error|unhandled runtime error/i.test(text)) crashed.push(label);
    }
    if (crashed.length) throw new Error(`crashed: ${crashed.join(", ")}`);
    return `${TENANT_ROUTES.length} routes OK`;
  });

  await step("screen-branch-detail", async () => {
    await page.goto(`${FRONTEND}/staff-branches`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Branches" }).click();
    await page.getByRole("link", { name: "Manage" }).first().click();
    await page.waitForURL(/\/staff-branches\/branches\//, { timeout: 15000 });
    return page.url();
  });

  await step("screen-customer-tabs", async () => {
    await page.goto(`${FRONTEND}/customers`, { waitUntil: "domcontentloaded" });
    await page.locator("tbody tr").first().click();
    await page.waitForURL(/\/customers\/[^/]+$/, { timeout: 15000 });
    for (const tab of [
      "Schemes",
      "Contributions",
      "Messages",
      "Customer",
      "Activity & audit",
    ]) {
      await page.getByRole("tab", { name: tab }).click();
      await page.waitForTimeout(350);
    }
    return "5 customer tabs";
  });

  await step("screen-enrollment-tabs-and-settlement-modes", async () => {
    const schemes = await apiGet(page, "/admin/schemes?limit=80");
    const rows = schemes.rows.map((row) => ({
      id: row.id ?? row._id,
      status: row.status,
      valueBasis: row.valueBasis ?? row.planSnapshot?.valueBasis,
      pattern: row.paymentPattern ?? row.planSnapshot?.paymentPattern,
    }));
    const wanted = [
      (r) => r.pattern === "FIXED" && r.status === "ACTIVE",
      (r) => r.pattern === "FLEXIBLE" && r.status === "LOCKED",
      (r) => r.valueBasis === "GOLD_WEIGHT" && r.status === "MATURED",
      (r) => r.status === "DEFAULTED",
      (r) => r.status === "REDEEMED",
    ];
    const picks = [];
    for (const match of wanted) {
      const found = rows.find((r) => r.id && match(r) && !picks.some((p) => p.id === r.id));
      if (found) picks.push(found);
    }
    if (!picks.length && rows[0]?.id) picks.push(rows[0]);

    const modeResults = [];
    for (const scheme of picks) {
      await page.goto(`${FRONTEND}/enrollments/${scheme.id}`, {
        waitUntil: "domcontentloaded",
      });
      for (const tab of ["Schedule", "Payment ledger", "Maturity", "Timeline"]) {
        const btn = page.getByRole("tab", { name: tab });
        if (await btn.count()) await btn.click();
        await page.waitForTimeout(250);
      }
      const preview = page.getByRole("button", { name: "Settlement preview" });
      if ((await preview.count()) && (await preview.isEnabled())) {
        await preview.click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ timeout: 10000 });
        const combo = dialog.getByRole("combobox");
        if (await combo.count()) {
          await combo.click();
          const modes = await page.getByRole("option").allInnerTexts();
          await page.keyboard.press("Escape");
          for (const mode of modes) {
            await dialog.getByRole("combobox").click();
            await page.getByRole("option", { name: mode, exact: true }).click();
            await page.waitForTimeout(450);
            const note = await dialog.innerText();
            modeResults.push({
              scheme: scheme.id,
              mode,
              ok: !/could not load settlement preview/i.test(note),
            });
          }
        }
        await page.keyboard.press("Escape");
      }
    }
    const bad = modeResults.filter((r) => !r.ok);
    if (bad.length) throw new Error(`${bad.length} settlement mode previews failed`);
    return `${picks.length} enrollments, ${modeResults.length} settlement modes`;
  });

  await step("kpi-dashboard", async () => {
    const dash = await apiGet(page, "/admin/dashboard/summary?period=THIS_MONTH");
    const trend = await apiGet(
      page,
      "/admin/dashboard/charts/collection-trend?period=THIS_MONTH",
    );
    const mode = await apiGet(
      page,
      "/admin/dashboard/charts/collection-by-mode?period=THIS_MONTH",
    );
    if (dash.status !== 200) throw new Error(`dashboard HTTP ${dash.status}`);
    if (mode.status !== 200) throw new Error(`collection-by-mode HTTP ${mode.status}`);
    const d = dash.data ?? dash.json?.data;
    await page.goto(`${FRONTEND}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.getByText("This month").first().click().catch(() => {});
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    const checks = [
      ["active customers", d?.customers?.active, "count"],
      ["open schemes", d?.schemes?.open ?? d?.schemes?.active, "count"],
      ["today payments", d?.today?.count, "count"],
    ];
    const missing = checks.filter(([, v]) => v != null && !bodyIncludesValue(body, v, { kind: "count" }));
    const trendText = JSON.stringify(trend.data ?? trend.json?.data ?? "");
    if (/NaN|null/i.test(trendText) && trendText.includes("NaN")) {
      throw new Error("collection-trend chart contains NaN");
    }
    if (missing.length) {
      throw new Error(`dashboard missing KPIs: ${missing.map((m) => m[0]).join(", ")}`);
    }
    return `dashboard KPIs + charts API OK (${checks.length} cards)`;
  });

  await step("kpi-dues-strip", async () => {
    const q = monthRangeQuery();
    const api = await apiGet(page, `/admin/dues?${q}&limit=1`);
    const summary = api.meta?.summary ?? api.json?.meta?.summary ?? api.data?.summary;
    if (!summary) throw new Error("dues API summary missing");
    await page.goto(`${FRONTEND}/dues`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    const body = await page.locator("body").innerText();
    const metrics = [
      ["due", summary.due, "rupees"],
      ["grace", summary.grace, "rupees"],
      ["overdue", summary.overdue, "rupees"],
      ["customers", summary.customers, "count"],
    ];
    for (const [name, value, kind] of metrics) {
      if (value != null && Number(value) > 0 && !bodyIncludesValue(body, value, { kind })) {
        throw new Error(`dues page missing ${name}=${value}`);
      }
    }
    return `dues strip matches API (${JSON.stringify(summary).slice(0, 120)}…)`;
  });

  await step("kpi-collections", async () => {
    const q = monthRangeQuery();
    const api = await apiGet(page, `/admin/payments?${q}&limit=5`);
    const summary = api.meta?.summary ?? api.json?.meta?.summary;
    await page.goto(`${FRONTEND}/collections`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    if (summary?.collected != null && summary.collected > 0) {
      if (!bodyIncludesValue(body, summary.collected, { kind: "rupees" })) {
        throw new Error(`collections missing collected=${summary.collected}`);
      }
    }
    const chartBlock = api.meta?.charts ?? api.json?.meta?.charts;
    if (chartBlock && /NaN/.test(JSON.stringify(chartBlock))) {
      throw new Error("collections mode chart NaN");
    }
    return "collections summary matches API";
  });

  await step("kpi-reminders-centre", async () => {
    const q = monthRangeQuery();
    const summary = await apiGet(page, `/admin/messaging/summary?${q}`);
    const payload = summary.data ?? summary.json?.data;
    await page.goto(`${FRONTEND}/reminders`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    for (const [key, kind] of [
      ["sent", "count"],
      ["delivered", "count"],
      ["failed", "count"],
    ]) {
      const v = payload?.[key];
      if (v != null && Number(v) > 0 && !bodyIncludesValue(body, v, { kind })) {
        throw new Error(`reminders missing ${key}=${v}`);
      }
    }
    return "reminder stat cards match messaging summary API";
  });

  await step("reminders-all-tabs", async () => {
    await page.goto(`${FRONTEND}/reminders`, { waitUntil: "domcontentloaded" });
    for (const tab of ["Message log", "Manual push", "Templates", "Schedule", "Quota"]) {
      await page.getByRole("tab", { name: tab }).click();
      await page.waitForTimeout(500);
    }
    await page.getByRole("tab", { name: "Templates" }).click();
    const preview = page.getByRole("button", { name: /Preview/i }).first();
    if (await preview.count()) {
      await preview.click();
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
    }
    await page.getByRole("tab", { name: "Manual push" }).click();
    await page.getByRole("heading", { name: "Send manual push" }).waitFor();
    const reach = page.getByRole("button", { name: "Estimate reach" });
    await reach.click();
    await page.getByText(/customers with devices/i).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Queue push to audience" }).waitFor();
    await page.getByRole("tab", { name: "Schedule" }).click();
    await page.waitForTimeout(400);

    await page.goto(`${FRONTEND}/dues`, { waitUntil: "domcontentloaded" });
    const row = page.locator("tbody tr").first();
    if (await row.count()) {
      const bell = row.locator("button").last();
      await bell.click();
      await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 12000 });
    }
    return "reminder tabs + template preview + manual push audience + schedule + dues bell";
  });

  await step("reports-all-kpi-on-page", async () => {
    const contract = JSON.parse(fs.readFileSync(REPORT_CONTRACT, "utf8"));
    const notes = [];
    for (const key of REPORT_KEYS) {
      const wait = page.waitForResponse(
        (r) => r.url().includes(`/admin/reports/${key}`) && r.request().method() === "GET",
        { timeout: 35000 },
      );
      await page.goto(`${FRONTEND}/reports?reportKey=${key}`, {
        waitUntil: "domcontentloaded",
      });
      const res = await wait;
      const json = await res.json();
      const built = json?.data ?? json;
      await page.getByText(built.title ?? key, { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(600);
      const body = await page.locator("body").innerText();
      const contractRow = contract.find((r) => r.key === key);
      for (const item of built.summary ?? []) {
        if (item.valueType === "currency" && item.value && typeof item.value === "object") {
          if (!bodyIncludesMoneyRef(body, item.value)) {
            throw new Error(
              `${key} summary "${item.label}" display ${item.value.amountDisplay ?? item.value.amountPaise} not visible`,
            );
          }
          continue;
        }
        const paise = item.value?.amountPaise;
        const num =
          typeof paise === "number"
            ? paise
            : typeof item.value === "number"
              ? item.value
              : null;
        if (num == null) continue;
        const onPage =
          item.valueType === "percent"
            ? body.includes(String(num)) || body.includes(`${num}%`)
            : bodyIncludesValue(body, num, { kind: paise != null ? "paise" : "rupees" });
        if (!onPage) {
          throw new Error(`${key} summary "${item.label}" value ${num} not visible on page`);
        }
      }
      const portfolio = (contractRow?.summaryFields ?? []).filter(
        (f) => f.contract === "PORTFOLIO_KPI",
      ).length;
      notes.push(`${key}: ${built.rows?.length ?? 0} rows, ${portfolio} portfolio KPIs documented`);
    }
    return notes.join("; ");
  });

  await step("action-activate-draft-plan", async () => {
    await page.goto(`${FRONTEND}/schemes`, { waitUntil: "domcontentloaded" });
    const activate = page.getByRole("button", { name: "Activate plan" }).first();
    if (!(await activate.count())) {
      return "skipped — no draft visible (filter Draft)";
    }
    await activate.click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /activated|active/i }).first().waitFor();
    return "draft plan activated";
  });

  await step("action-reverse-payment", async () => {
    await page.goto(`${FRONTEND}/collections`, { waitUntil: "domcontentloaded" });
    const q = page.getByPlaceholder(/Receipt/i);
    if (await q.count()) await q.fill("E2E reverse seed");
    await page.waitForTimeout(600);
    const reverse = page.getByRole("button", { name: "Reverse" }).first();
    if (!(await reverse.count())) {
      await page.goto(`${FRONTEND}/collections`, { waitUntil: "domcontentloaded" });
      const anyReverse = page.getByRole("button", { name: "Reverse" }).first();
      if (!(await anyReverse.count())) return "skipped — no reversible payment in view";
      await anyReverse.click();
    } else {
      await reverse.click();
    }
    const dialog = page.getByRole("alertdialog");
    await dialog.locator("textarea").fill("E2E parity reversal");
    await dialog.getByRole("button", { name: "Reverse payment" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /reversed/i }).first().waitFor();
    return "payment reversed";
  });

  await step("action-reject-approved-redemption", async () => {
    const approved = await apiGet(page, "/admin/redemptions?status=APPROVED&limit=5");
    const row = approved.rows[0];
    if (!row) return "skipped — no APPROVED redemption";
    const redId = row.id ?? row._id;
    await page.goto(`${FRONTEND}/maturity?review=${redId}`, { waitUntil: "domcontentloaded" });
    const sheet = page.locator("[role=dialog]").last();
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Reject this request instead" }).click();
    await sheet.locator("textarea").last().fill("E2E parity reject approved");
    await sheet.getByRole("button", { name: "Confirm reject" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /reject/i }).first().waitFor();
    return `rejected ${redId}`;
  });

  await step("action-redemption-complete-matrix", async () => {
    const modes = ["CASH", "GOLD_HANDOVER", "PURCHASE_ADJUSTMENT"];
    const done = [];
    for (const mode of modes) {
      const pending = await apiGet(page, "/admin/redemptions?status=PENDING_APPROVAL&limit=30");
      const approved = await apiGet(page, "/admin/redemptions?status=APPROVED&limit=30");
      let target =
        pending.rows.find((r) => String(r.mode) === mode) ??
        approved.rows.find((r) => String(r.mode) === mode);
      if (!target && mode === "CASH") target = pending.rows[0] ?? approved.rows[0];
      if (!target) continue;
      const redId = target.id ?? target._id;
      await page.goto(`${FRONTEND}/maturity?review=${redId}`, { waitUntil: "domcontentloaded" });
      const sheet = page.locator("[role=dialog]").last();
      await sheet.waitFor({ timeout: 15000 });
      const approve = sheet.getByRole("button", { name: "Approve redemption" });
      if (await approve.count()) await approve.click();
      if (mode === "PURCHASE_ADJUSTMENT") {
        const bill = sheet.getByPlaceholder(/bill/i);
        if (await bill.count()) await bill.fill("E2E-PARITY-BILL");
      }
      const complete = sheet.getByRole("button", { name: "Complete handover" });
      if (!(await complete.count())) continue;
      await complete.click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Confirm handover" }).click();
      await page.locator("[data-sonner-toast]").filter({ hasText: /completed|handover/i }).first().waitFor({ timeout: 30000 });
      done.push(mode);
    }
    if (!done.length) return "skipped — no redemption completed (queue/state)";
    return `completed: ${done.join(", ")}`;
  });

  const failed = findings.filter((f) => !f.ok);
  expect(
    failed,
    failed.map((f) => `${f.area}: ${f.detail}`).join("\n"),
  ).toEqual([]);
});
