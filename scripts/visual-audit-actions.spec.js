import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FRONTEND_BASE = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const API_BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const ROOT = path.resolve(".");
const MANIFEST_PATH = path.join(ROOT, "docs/e2e-audit-manifest.json");
const RESULT_PATH = path.join(ROOT, "docs/e2e-audit-results.json");

const REPORTS = [
  "COLLECTION",
  "ENROLMENT",
  "OUTSTANDING",
  "MATURITY_REDEMPTION",
  "GOLD_ACCRUAL",
  "CUSTOMER_PERFORMANCE",
  "STAFF_PERFORMANCE",
  "CASH_HANDOVER",
  "REMINDER_DELIVERY",
  "WHATSAPP_USAGE",
  "SCHEME_REGISTER",
  "DEFAULTER",
  "BRANCH_PERFORMANCE",
  "SCHEME_PERFORMANCE",
];

const findings = [];
const manifest = {};

function note(area, ok, detail) {
  findings.push({ area, ok, detail });
  fs.writeFileSync(RESULT_PATH, JSON.stringify({ findings, manifest }, null, 2));
}

function saveManifest() {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function auditDb() {
  saveManifest();
  execFileSync(
    "node",
    ["--env-file=.env", "scripts/audit-portal-state.js", MANIFEST_PATH],
    { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
  );
  const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/e2e-audit-db.json"), "utf8"));
  for (const row of parsed.issues ?? []) note(row.area, false, row.detail);
  if ((parsed.issues ?? []).length === 0) note("database", true, "saved records match the action");
  return parsed;
}

async function fillControlled(locator, value) {
  await locator.waitFor({ state: "visible" });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await locator.click();
    await locator.fill(value);
    if ((await locator.inputValue()) === value) return;
    await locator.page().waitForTimeout(300);
  }
  throw new Error(`Input did not keep "${value}"`);
}

async function tokenGet(page, apiPath) {
  const token = await page.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
  const response = await page.request.get(`${API_BASE}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => ({}));
  const data = json?.data;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return { status: response.status(), rows, json };
}

test("audit portal actions against the database", async ({ page }) => {
  test.setTimeout(6 * 60 * 1000);
  const stamp = String(Date.now()).slice(-6);
  const mobile = `9${stamp}001`;
  const staffMobile = `9${stamp}002`;
  const customerName = `Audit Customer ${stamp}`;
  const branchName = `Audit Branch ${stamp}`;
  const branchCode = `A${stamp.slice(0, 4)}`;
  const staffName = `Audit Staff ${stamp}`;

  await page.goto(`${FRONTEND_BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await fillControlled(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fillControlled(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });

  const dashboardResponse = page.waitForResponse(
    (response) => response.url().includes("/admin/dashboard") && response.request().method() === "GET",
    { timeout: 20000 },
  );
  await page.goto(`${FRONTEND_BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  const dashboardJson = await (await dashboardResponse).json().catch(() => ({}));
  manifest.dashboard = { period: "THIS_MONTH", raw: dashboardJson?.data ?? dashboardJson };
  const body = await page.locator("body").innerText();
  const crash = /application error: a |unhandled runtime error|could not load dashboard/i.test(body);
  note("dashboard", !crash, crash ? "dashboard page crashed" : "dashboard loaded");
  for (const widget of manifest.dashboard.raw?.widgets ?? []) {
    const label = String(widget.label ?? "");
    if (label && !body.includes(label)) note("dashboard", false, `widget "${label}" is not on the page`);
  }
  const summaryCards = [
    ["Active customers", manifest.dashboard.raw?.customers?.active],
    ["Open enrollments", manifest.dashboard.raw?.schemes?.open],
    ["Matured schemes", manifest.dashboard.raw?.schemes?.matured],
    ["Open redemptions", manifest.dashboard.raw?.attention?.openRedemptions],
  ];
  for (const [label, value] of summaryCards) {
    if (value == null) note("dashboard", false, `API summary missing ${label}`);
    else if (!body.includes(String(value))) {
      note("dashboard", false, `page does not show ${label} value ${value}`);
    } else note("dashboard", true, `${label} = ${value}`);
  }

  const maturityResponse = page.waitForResponse(
    (response) => response.url().includes("/admin/maturities") && !response.url().includes("/calendar"),
    { timeout: 20000 },
  );
  await page.goto(`${FRONTEND_BASE}/maturity`, { waitUntil: "domcontentloaded" });
  const maturityHttp = await maturityResponse;
  const maturityUrl = new URL(maturityHttp.url());
  const maturityJson = await maturityHttp.json().catch(() => ({}));
  const maturitySummary = maturityJson?.data?.summary ?? maturityJson?.summary ?? {};
  manifest.maturity = {
    query: Object.fromEntries(maturityUrl.searchParams.entries()),
    summary: maturitySummary,
  };
  const maturityText = await page.locator("body").innerText();
  for (const [label, value] of [
    ["Upcoming 30 days", maturitySummary.upcoming],
    ["Matured today", maturitySummary.maturedToday],
    ["Matured not redeemed", maturitySummary.notRedeemed],
  ]) {
    if (value == null) note("maturity", false, `summary missing ${label}`);
    else if (!maturityText.includes(String(value))) {
      note("maturity", false, `page does not show ${label} count ${value}`);
    } else note("maturity", true, `${label} = ${value}`);
  }
  auditDb();
  delete manifest.dashboard;
  delete manifest.maturity;

  try {
    await page.goto(`${FRONTEND_BASE}/customers`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create customer" }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByPlaceholder("Customer full name").fill(customerName);
    await createDialog.getByRole("textbox").nth(1).fill(mobile);
    await createDialog.getByRole("combobox").click();
    const branchOption = page.getByRole("option").first();
    const branchLabel = await branchOption.innerText();
    await branchOption.click();
    await createDialog.getByRole("button", { name: "Create customer" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /created/i }).first().waitFor({ timeout: 15000 });
    await page.keyboard.press("Escape");
    manifest.customer = { name: customerName, mobile, branchLabel };
    note("customer", true, `created ${customerName} at ${branchLabel}`);
  } catch (error) {
    note("customer", false, String(error.message ?? error).slice(0, 240));
  }

  try {
    const createdRow = page.locator("tbody tr").filter({ hasText: customerName }).first();
    await createdRow.waitFor({ timeout: 15000 });
    await createdRow.click();
    await page.waitForURL(/\/customers\/[^/]+$/, { timeout: 15000 });
    await page.getByRole("button", { name: "Create enrollment" }).click();
    const enrol = page.getByRole("dialog");
    await enrol.getByRole("combobox").first().click();
    const planOptions = page.getByRole("option");
    const planCount = await planOptions.count();
    let planName = "";
    let picked = false;
    for (let index = 0; index < planCount; index += 1) {
      planName = await planOptions.nth(index).innerText();
      if (!/gold/i.test(planName)) {
        await planOptions.nth(index).click();
        picked = true;
        break;
      }
    }
    if (!picked && planCount) {
      planName = await planOptions.first().innerText();
      await planOptions.first().click();
    }
    await expect(enrol.getByRole("button", { name: "Confirm enrolment" })).toBeEnabled({ timeout: 20000 });
    await enrol.getByRole("button", { name: "Confirm enrolment" }).click();
    await page.waitForURL(/\/enrollments\/[^/]+$/, { timeout: 25000 });
    manifest.scheme = { id: page.url().split("/").pop(), planName };
    note("enrollment", true, `enrolled ${planName} as ${manifest.scheme.id}`);
  } catch (error) {
    note("enrollment", false, String(error.message ?? error).slice(0, 240));
  }

  try {
    await page.goto(`${FRONTEND_BASE}/staff-branches`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add branch" }).click();
    const branchDialog = page.getByRole("dialog");
    await branchDialog.getByPlaceholder("Panampilly Nagar").fill(branchName);
    await branchDialog.getByPlaceholder("PMN").fill(branchCode);
    await branchDialog.getByRole("button", { name: "Create branch" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /created/i }).first().waitFor({ timeout: 15000 });
    manifest.branch = { name: branchName, code: branchCode };
    note("branch", true, `created ${branchCode}`);
    await page.keyboard.press("Escape").catch(() => {});
  } catch (error) {
    note("branch", false, String(error.message ?? error).slice(0, 240));
  }

  try {
    await page.goto(`${FRONTEND_BASE}/staff-branches`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create staff" }).click();
    const staffDialog = page.getByRole("dialog");
    const boxes = staffDialog.getByRole("textbox");
    await boxes.nth(0).fill(staffName);
    await boxes.nth(1).fill(staffMobile);
    await staffDialog.getByPlaceholder("Min. 4 digits").fill("2026");
    await staffDialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option").first().click();
    await staffDialog.getByRole("button", { name: "Create staff" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /created/i }).first().waitFor({ timeout: 15000 });
    manifest.staff = { name: staffName, mobile: staffMobile };
    note("staff", true, `created ${staffName}`);
  } catch (error) {
    note("staff", false, String(error.message ?? error).slice(0, 240));
  }

  for (const reportKey of REPORTS) {
    try {
      const reportResponse = page.waitForResponse(
        (response) => response.url().includes(`/admin/reports/${reportKey}`) && response.request().method() === "GET",
        { timeout: 20000 },
      );
      await page.goto(`${FRONTEND_BASE}/reports?reportKey=${reportKey}`, { waitUntil: "domcontentloaded" });
      const response = await reportResponse;
      const json = await response.json().catch(() => ({}));
      const text = await page.locator("body").innerText();
      const failed = response.status() >= 400 || /could not load|something went wrong|unhandled runtime error/i.test(text);
      const rowCount = Array.isArray(json?.data?.rows) ? json.data.rows.length : Array.isArray(json?.data) ? json.data.length : null;
      note(
        "report",
        !failed,
        failed
          ? `${reportKey} HTTP ${response.status()}`
          : `${reportKey} loaded${rowCount == null ? "" : `, ${rowCount} rows`}`,
      );
    } catch (error) {
      note("report", false, `${reportKey}: ${String(error.message ?? error).slice(0, 180)}`);
    }
  }

  try {
    const open = await tokenGet(page, "/admin/redemptions?status=PENDING_APPROVAL&limit=100");
    const requested = await tokenGet(page, "/admin/redemptions?status=REQUESTED&limit=100");
    const approved = await tokenGet(page, "/admin/redemptions?status=APPROVED&limit=100");
    const busy = new Set(
      [...open.rows, ...requested.rows, ...approved.rows].map((row) => String(row.schemeId ?? row.scheme?.id ?? "")),
    );
    const matured = await tokenGet(page, "/admin/schemes?status=MATURED&limit=100");
    const candidate = matured.rows.find((row) => !busy.has(String(row.id ?? row._id)));
    if (!candidate) {
      note("redemption", false, "no matured scheme is free for a new redemption request");
    } else {
      const schemeId = candidate.id ?? candidate._id;
      await page.goto(`${FRONTEND_BASE}/enrollments/${schemeId}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: "Maturity" }).click();
      await page.getByRole("button", { name: "Initiate redemption" }).click();
      const redeem = page.getByRole("dialog");
      await expect(redeem.getByRole("button", { name: "Submit redemption" })).toBeEnabled({ timeout: 20000 });
      const created = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().includes("redemption"),
        { timeout: 20000 },
      );
      await redeem.getByRole("button", { name: "Submit redemption" }).click();
      const createdResponse = await created;
      const createdJson = await createdResponse.json().catch(() => ({}));
      if (createdResponse.status() >= 400) {
        note("redemption", false, `create failed HTTP ${createdResponse.status()} ${JSON.stringify(createdJson).slice(0, 180)}`);
      } else {
        const redemptionId = createdJson?.data?.id ?? createdJson?.data?._id ?? createdJson?.id;
        await page.locator("[data-sonner-toast]").filter({ hasText: /submitted|created|requested/i }).first().waitFor({ timeout: 15000 }).catch(() => {});
        await page.goto(`${FRONTEND_BASE}/maturity`, { waitUntil: "domcontentloaded" });
        await page.getByRole("tab", { name: "Redemption queue" }).click();
        await page.getByRole("row").filter({ hasText: candidate.enrollmentNumber ?? candidate.schemeNumber ?? "" }).first().click();
        await page.getByRole("button", { name: "Approve redemption" }).click();
        await page.locator("[data-sonner-toast]").filter({ hasText: /approved/i }).first().waitFor({ timeout: 20000 });
        manifest.redemption = {
          id: redemptionId,
          schemeId,
          enrollmentNumber: candidate.enrollmentNumber ?? candidate.schemeNumber,
        };
        note("redemption", true, `approved ${manifest.redemption.enrollmentNumber}`);
      }
    }
  } catch (error) {
    note("redemption", false, String(error.message ?? error).slice(0, 240));
  }

  const db = auditDb();
  saveManifest();
  const failed = findings.filter((row) => !row.ok);
  expect(failed.map((row) => `${row.area}: ${row.detail}`).join("\n") || db.issues).toEqual([]);
});
