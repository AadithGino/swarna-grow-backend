/**
 * Phase 9 browser smoke — 8 isolated areas, live portal + API.
 * Prerequisites: dev:api :4050, worker (PROVIDER_MODE=mock), portal :5173.
 *
 * FRONTEND_BASE=http://localhost:5173 API_BASE=http://localhost:4050/api/v1 \
 *   npx playwright test scripts/digital-metals-phase9-browser-smoke.spec.js --reporter=line --workers=1
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  PHASE9_SMOKE_CUSTOMER_MOBILE,
  initRunId,
  pollArtifactViaApi,
  recordFinding,
  safeGoto,
  smokeResultsPath,
} from "./digital-metals-phase9-smoke-lib.js";

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const API = process.env.API_BASE ?? "http://localhost:4050/api/v1";
const ADMIN_STATE = path.resolve("test-results/phase9-admin-storage.json");
const CUSTOMER_STATE = path.resolve("test-results/phase9-customer-storage.json");

let runId = "";
let resultsPath = "";
/** @type {{ area: string, ok: boolean, detail: string, at: string }[]} */
let findings = [];

async function fill(locator, value) {
  await locator.click();
  await locator.fill(String(value));
}

async function adminLogin(page, mobile, org = "KAIRALI") {
  await safeGoto(page, `${FRONTEND}/login`, "admin login");
  await fill(page.locator('input[autocomplete="username"]').first(), mobile);
  await fill(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fill(page.locator('input[autocomplete="organization"]').first(), org);
  const settingsHit = page.waitForResponse(
    (r) => r.url().includes("/admin/settings") && r.status() < 500,
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 30_000 });
  const settingsRes = await settingsHit;
  if (!settingsRes) throw new Error("portal did not reach backend settings API after login");
}

async function customerLogin(page, mobile = PHASE9_SMOKE_CUSTOMER_MOBILE) {
  await safeGoto(page, `${FRONTEND}/customer/kairali/login`, "customer login");
  await page.locator("#mobile").waitFor({ state: "visible", timeout: 30_000 });
  if (await page.locator("#password").isVisible().catch(() => false)) {
    await fill(page.locator("#mobile"), mobile);
    await fill(page.locator("#password"), "2026");
    await page.getByRole("button", { name: "Sign in" }).click();
  } else {
    await fill(page.locator("#mobile"), mobile);
    await page.getByRole("button", { name: /Send secure OTP/i }).click();
    await fill(page.locator("#otp"), "123456");
    await page.getByRole("button", { name: /Verify & continue/i }).click();
  }
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 35_000 });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  execFileSync("node", ["--env-file=.env", "scripts/digital-metals-phase9-browser-setup.js"], {
    cwd: path.resolve("."),
    stdio: "inherit",
  });
  runId = initRunId();
  resultsPath = smokeResultsPath(runId);
  findings = [
    {
      area: "_meta",
      ok: true,
      detail: JSON.stringify({ runId, frontend: FRONTEND, api: API, startedAt: new Date().toISOString() }),
      at: new Date().toISOString(),
    },
  ];
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(findings, null, 2));
  fs.mkdirSync(path.dirname(ADMIN_STATE), { recursive: true });
});

test.afterAll(() => {
  const latest = path.resolve("docs/phase9-browser-smoke-results-latest.json");
  fs.copyFileSync(resultsPath, latest);
  const passed = findings.filter((f) => f.ok && !f.area.startsWith("_")).length;
  const total = findings.filter((f) => !f.area.startsWith("_")).length;
  process.stdout.write(`\nRun ${runId}: ${passed}/${total} → ${resultsPath}\n`);
});

test("1 portal-api-connectivity", async ({ page }) => {
  test.setTimeout(120_000);
  try {
    await adminLogin(page, "9847012347");
    await page.context().storageState({ path: ADMIN_STATE });
    const token = await page.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
    const cap = await page.request.get(`${API}/admin/digital-metals/capability`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cap.status()).toBe(200);
    recordFinding(resultsPath, findings, "portal-api-connectivity", true, `capability HTTP ${cap.status()}`);
  } catch (e) {
    recordFinding(resultsPath, findings, "portal-api-connectivity", false, String(e?.message ?? e).slice(0, 500));
  }
});

test("2 procurement-ui-flow", async ({ browser }) => {
  test.setTimeout(180_000);
  const maker = await browser.newPage();
  const approver = await browser.newPage();
  try {
    await adminLogin(maker, "9847012347");
    await safeGoto(maker, `${FRONTEND}/digital-metals/procurement`, "procurement");
    await expect(maker.getByTestId("digital-metals-procurement")).toBeVisible({ timeout: 20_000 });
    await maker.getByTestId("digital-metals-procurement").getByLabel("Type").selectOption("COMMITMENT");
    await maker.getByLabel(/Evidence upload IDs/i).fill("phase9-smoke-evidence");
    const createResp = maker.waitForResponse(
      (r) => r.url().includes("/procurement/entries") && r.request().method() === "POST",
      { timeout: 25_000 },
    );
    await maker.getByRole("button", { name: "Submit for approval" }).click();
    const created = await createResp;
    expect(created.status()).toBeLessThan(400);
    const commitmentId = (await created.json())?.data?.id;
    if (!commitmentId) throw new Error("missing commitment id");

    await adminLogin(approver, "9847012345");
    const detailLoad = approver.waitForResponse(
      (r) =>
        r.url().includes(`/procurement/entries/${encodeURIComponent(commitmentId)}`) &&
        r.request().method() === "GET" &&
        r.ok(),
      { timeout: 25_000 },
    );
    await safeGoto(
      approver,
      `${FRONTEND}/digital-metals/procurement?entryId=${encodeURIComponent(commitmentId)}`,
      "procurement approver deep link",
    );
    await detailLoad;
    await expect(approver.getByText(commitmentId)).toBeVisible({ timeout: 20_000 });
    const approverToken = await approver.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
    const pendingApi = await approver.request.get(
      `${API}/admin/digital-metals/procurement/entries?status=PENDING_APPROVAL`,
      { headers: { Authorization: `Bearer ${approverToken}` } },
    );
    const pendingItems = (await pendingApi.json())?.data?.items ?? [];
    if (!pendingItems.some((i) => i.id === commitmentId)) {
      throw new Error(
        `commitment ${commitmentId} missing from pending API (${pendingItems.length} rows)`,
      );
    }
    const approveBtn = approver.getByRole("button", { name: "Approve", exact: true });
    if (!(await approveBtn.isVisible().catch(() => false))) {
      const statusFilter = approver.locator('select:has(option[value="PENDING_APPROVAL"])');
      const pendingList = approver.waitForResponse(
        (r) =>
          r.url().includes("/procurement/entries") &&
          r.url().includes("status=PENDING_APPROVAL") &&
          r.request().method() === "GET" &&
          r.ok(),
        { timeout: 20_000 },
      );
      await statusFilter.selectOption("PENDING_APPROVAL");
      await pendingList;
      const row = approver
        .getByTestId(`procurement-entry-${commitmentId}`)
        .or(
          approver
            .getByTestId("digital-metals-procurement")
            .getByRole("button")
            .filter({ hasText: "1000000" }),
        );
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.click();
    }
    await expect(approveBtn).toBeVisible({ timeout: 15_000 });
    const approveResp = approver.waitForResponse(
      (r) => r.url().includes("/approve") && r.request().method() === "POST",
      { timeout: 25_000 },
    );
    await approveBtn.click();
    expect((await approveResp).status()).toBeLessThan(400);

    recordFinding(
      resultsPath,
      findings,
      "procurement-ui-flow",
      true,
      `UI create + approver UI approve commitment ${commitmentId.slice(-6)}`,
    );
  } catch (e) {
    recordFinding(resultsPath, findings, "procurement-ui-flow", false, String(e?.message ?? e).slice(0, 500));
  } finally {
    await maker.close();
    await approver.close();
  }
});

test("3 deep-link-refresh-hedge", async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ storageState: ADMIN_STATE });
  try {
    await safeGoto(page, `${FRONTEND}/digital-metals/hedge`, "hedge");
    await expect(page.getByTestId("digital-metals-hedge")).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByTestId("digital-metals-hedge")).toBeVisible({ timeout: 20_000 });
    recordFinding(resultsPath, findings, "deep-link-refresh-hedge", true, "hedge testid visible after reload");
  } catch (e) {
    recordFinding(resultsPath, findings, "deep-link-refresh-hedge", false, String(e?.message ?? e).slice(0, 500));
  } finally {
    await page.close();
  }
});

test("4 hedge-invalidation-banner", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await browser.newPage({ storageState: ADMIN_STATE });
  try {
    await safeGoto(page, `${FRONTEND}/dashboard`, "admin dashboard");
    const token = await page.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
    const d1 = "2026-10-22";
    const d2 = "2026-10-23";
    for (const d of [d1, d2]) {
      const res = await page.request.post(`${API}/admin/digital-metals/hedge/snapshots/close-day`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Idempotency-Key": randomUUID(),
          "Content-Type": "application/json",
        },
        data: { businessDate: d },
      });
      if (res.status() >= 400 && res.status() !== 409) throw new Error(`close ${d} HTTP ${res.status()}`);
    }
    await page.request.post(`${API}/admin/digital-metals/hedge/snapshots/close-day`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Idempotency-Key": randomUUID(),
        "Content-Type": "application/json",
      },
      data: { businessDate: d1, revisionReason: "Phase9 smoke revision" },
    });
    await safeGoto(page, `${FRONTEND}/digital-metals/hedge`, "hedge after revision");
    await expect(page.getByText(/invalidated|Re-close|recomputation/i).first()).toBeVisible({
      timeout: 15_000,
    });
    const inv = await page.request.get(`${API}/admin/digital-metals/hedge/snapshots-invalidated`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    for (const row of (await inv.json())?.data?.items ?? []) {
      await page.request.post(`${API}/admin/digital-metals/hedge/snapshots/close-day`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Idempotency-Key": randomUUID(),
          "Content-Type": "application/json",
        },
        data: { businessDate: row.businessDate, revisionReason: "Re-close smoke" },
      });
    }
    await page.reload();
    await expect(page.getByText(/invalidated|Re-close|recomputation/i)).toHaveCount(0, { timeout: 10_000 });
    recordFinding(resultsPath, findings, "hedge-invalidation-banner", true, "banner cleared after re-close");
  } catch (e) {
    recordFinding(resultsPath, findings, "hedge-invalidation-banner", false, String(e?.message ?? e).slice(0, 500));
  } finally {
    await page.close();
  }
});

test("5 admin-document-surfaces", async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ storageState: ADMIN_STATE });
  try {
    await safeGoto(page, `${FRONTEND}/digital-metals/sells`, "sells");
    await expect(page.getByTestId("digital-metals-sells-list")).toBeVisible();
    await safeGoto(page, `${FRONTEND}/digital-metals/payouts`, "payouts");
    await expect(page.getByTestId("digital-metals-payouts-workspace")).toBeVisible();
    await safeGoto(page, `${FRONTEND}/digital-metals/redemption/orders`, "redemption orders");
    await expect(page.getByTestId("digital-metals-redemption-orders")).toBeVisible();
    recordFinding(resultsPath, findings, "admin-document-surfaces", true, "sells, payouts, redemption lists");
  } catch (e) {
    recordFinding(resultsPath, findings, "admin-document-surfaces", false, String(e?.message ?? e).slice(0, 500));
  } finally {
    await page.close();
  }
});

test("6 permission-denial-procurement", async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  try {
    await adminLogin(page, "9847012353");
    await safeGoto(page, `${FRONTEND}/digital-metals/procurement`, "procurement staff");
    const visible = await page.getByTestId("digital-metals-procurement").isVisible().catch(() => false);
    if (visible) throw new Error("procurement workspace visible for Kochi staff");
    recordFinding(resultsPath, findings, "permission-denial-procurement", true, "procurement hidden for limited staff");
  } catch (e) {
    recordFinding(resultsPath, findings, "permission-denial-procurement", false, String(e?.message ?? e).slice(0, 500));
  } finally {
    await page.close();
  }
});

test("7 customer-statement-document", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await browser.newPage();
  try {
    await customerLogin(page);
    await page.context().storageState({ path: CUSTOMER_STATE });
    await safeGoto(page, `${FRONTEND}/customer/kairali/digital-metals`, "customer digital metals");
    await expect(page.getByTestId("customer-digital-metals-statement")).toBeVisible({ timeout: 20_000 });
    const dates = page.getByTestId("customer-digital-metals-statement").locator('input[type="date"]');
    await dates.nth(0).fill("2026-10-01");
    await dates.nth(1).fill("2026-10-19");
    await page.waitForTimeout(800);
    const panel = page.getByTestId("digital-metals-document-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    let artifactId = "";
    const downloadBtn = panel.getByRole("button", { name: "Download" });
    if (await downloadBtn.isVisible().catch(() => false)) {
      const customerTokenEarly = await page.evaluate(() =>
        localStorage.getItem("swarnagrow.customer.accessToken"),
      );
      const bySubject = await page.request.get(
        `${API}/app/digital-metals/documents/by-subject?docType=METAL_STATEMENT&fromBusinessDate=2026-10-01&toBusinessDate=2026-10-19`,
        { headers: { Authorization: `Bearer ${customerTokenEarly}` } },
      );
      expect(bySubject.status()).toBeLessThan(400);
      artifactId = (await bySubject.json())?.data?.artifact?.id ?? "";
    } else if (await panel.getByText(/Generating/i).isVisible().catch(() => false)) {
      const customerTokenEarly = await page.evaluate(() =>
        localStorage.getItem("swarnagrow.customer.accessToken"),
      );
      const bySubject = await page.request.get(
        `${API}/app/digital-metals/documents/by-subject?docType=METAL_STATEMENT&fromBusinessDate=2026-10-01&toBusinessDate=2026-10-19`,
        { headers: { Authorization: `Bearer ${customerTokenEarly}` } },
      );
      artifactId = (await bySubject.json())?.data?.artifact?.id ?? "";
    } else {
      const reqBtn = panel.getByRole("button", { name: /Request PDF|Request again/i });
      await expect(reqBtn).toBeVisible({ timeout: 20_000 });
      const docPost = page.waitForResponse(
        (r) => r.url().includes("/digital-metals/documents/request") && r.request().method() === "POST",
        { timeout: 30_000 },
      );
      await reqBtn.click();
      const postRes = await docPost;
      expect(postRes.status()).toBeLessThan(400);
      artifactId = (await postRes.json())?.data?.id;
    }
    if (!artifactId) throw new Error("no artifact id from request or by-subject");

    const customerToken = await page.evaluate(() => localStorage.getItem("swarnagrow.customer.accessToken"));
    const poll = await pollArtifactViaApi(page.request, API, customerToken, artifactId, {
      maxMs: 90_000,
      pollMs: 3000,
    });
    if (!poll.ok) {
      execFileSync(
        "node",
        ["--env-file=.env", "scripts/digital-metals-phase9-statement-trace.js", artifactId],
        { cwd: path.resolve("."), stdio: "pipe", env: { ...process.env, PROVIDER_MODE: "mock" } },
      );
      throw new Error(`artifact ${artifactId} ${poll.status}: ${poll.error}`);
    }

    const dl = await page.request.get(`${API}/app/digital-metals/documents/${artifactId}/download-url`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    expect(dl.status()).toBe(200);
    expect((await dl.json())?.data?.downloadUrl).toBeTruthy();
    recordFinding(
      resultsPath,
      findings,
      "customer-statement-document",
      true,
      `READY + download-url HTTP ${dl.status()}`,
    );
  } catch (e) {
    recordFinding(resultsPath, findings, "customer-statement-document", false, String(e?.message ?? e).slice(0, 500));
  } finally {
    await page.close();
  }
});

test("8 paused-trading-customer-capability", async ({ browser }) => {
  test.setTimeout(120_000);
  const adminPage = await browser.newPage({ storageState: ADMIN_STATE });
  const custPage = await browser.newPage({ storageState: CUSTOMER_STATE });
  try {
    await safeGoto(adminPage, `${FRONTEND}/dashboard`, "admin dashboard for pause test");
    const token = await adminPage.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
    if (!token) throw new Error("missing admin token after storageState navigation");
    await adminPage.request.patch(`${API}/admin/settings/operations`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": randomUUID(),
      },
      data: { digitalMetalsPaused: true, digitalMetalsPauseReason: "Phase9 smoke pause" },
    });
    await safeGoto(custPage, `${FRONTEND}/customer/kairali/digital-metals`, "customer capability paused");
    const capRes = await custPage.waitForResponse(
      (r) => r.url().includes("/app/digital-metals/capability"),
      { timeout: 25_000 },
    );
    const capJson = await capRes.json();
    expect(capJson?.data?.canPlaceNewBuy).toBe(false);
    expect(capJson?.data?.canViewHoldings).toBe(true);
    recordFinding(resultsPath, findings, "paused-trading-customer-capability", true, "canPlaceNewBuy false");
    await adminPage.request.patch(`${API}/admin/settings/operations`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": randomUUID(),
      },
      data: { digitalMetalsPaused: false },
    });
  } catch (e) {
    recordFinding(resultsPath, findings, "paused-trading-customer-capability", false, String(e?.message ?? e).slice(0, 500));
  } finally {
    await adminPage.close();
    await custPage.close();
  }
});

test("9 smoke summary", async () => {
  const failed = findings.filter((f) => !f.ok && !f.area.startsWith("_"));
  expect(failed, `failed areas: ${failed.map((f) => f.area).join(", ")}`).toHaveLength(0);
});
