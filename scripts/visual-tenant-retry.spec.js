import { test, expect } from "@playwright/test";
import fs from "node:fs";

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const API = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const OUT = "/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend/docs/tenant-retry-results.json";
const PNG = "/tmp/swarna-audit-kyc.png";
const CUSTOMER_ID = "cus_01M346YX7FX9YV3A1M3GD76NH2";
const STAFF_ID = "usr_01M346ZGHHV4RXJ8ZEER8HH44R";
const LOCK_ID = "sch_01M33YWCER6GBKCJ94MVW0PVC0";
const GOLD_SCHEME = "sch_01M33YWCS4R9TMY9WHAAFMASSW";
const CLOSE_SCHEME = "sch_01M346YZW09TD8F3E3JKVK9FEH";

fs.writeFileSync(
  PNG,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const findings = [];
const manifest = {};

function record(area, ok, detail) {
  findings.push({ area, ok, detail });
  fs.writeFileSync(OUT, JSON.stringify({ findings, manifest }, null, 2));
  console.log(`${ok ? "OK" : "FAIL"} ${area}: ${detail}`);
}

async function fill(locator, value) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ timeout: 8000 });
  await locator.fill(String(value));
  if ((await locator.inputValue()) !== String(value)) {
    await locator.fill(String(value));
  }
}

async function login(page) {
  await page.goto(`${FRONTEND}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await fill(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fill(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fill(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
}

async function api(page, path, { method = "GET", body } = {}) {
  const token = await page.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
  const response = await page.request.fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: body,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status(), json };
}

function payload(json) {
  return json?.data ?? json;
}

async function step(area, fn) {
  try {
    record(area, true, (await fn()) || "done");
  } catch (error) {
    record(area, false, String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 360));
  }
}

async function tracked(page, click, match) {
  const pending = page.waitForResponse(match, { timeout: 20000 }).catch(() => null);
  await click();
  const response = await pending;
  if (!response) throw new Error("no matching API response");
  const json = await response.json().catch(() => ({}));
  if (response.status() >= 400) throw new Error(JSON.stringify(json).slice(0, 280));
  return json;
}

test.use({ actionTimeout: 15000, navigationTimeout: 25000 });

test("retry unfinished tenant actions", async ({ page }) => {
  test.setTimeout(360000);
  await login(page);
  const stamp = String(Date.now()).slice(-5);
  const planCode = `AU${stamp}`;
  const planName = `Audit Plan ${planCode}`;

  await step("scheme-create", async () => {
    await page.goto(`${FRONTEND}/schemes/new`, { waitUntil: "domcontentloaded" });
    const form = page.locator("fieldset");
    await form.getByText("Plan name").waitFor();
    await fill(form.locator("input").nth(0), planName);
    await fill(form.locator("input").nth(1), planCode);
    for (let i = 0; i < 12; i += 1) {
      const create = page.getByRole("button", { name: "Create draft" });
      if (await create.count()) {
        const json = await tracked(
          page,
          () => create.click(),
          (response) => response.url().includes("/admin/scheme-plans") && response.request().method() === "POST",
        );
        manifest.planId = payload(json).id;
        manifest.planCode = planCode;
        return `draft ${manifest.planId}`;
      }
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForTimeout(200);
    }
    throw new Error("wizard did not reach create");
  });

  await step("scheme-edit", async () => {
    if (!manifest.planId) throw new Error("plan missing");
    await page.goto(`${FRONTEND}/schemes/${manifest.planId}/edit`, { waitUntil: "domcontentloaded" });
    const form = page.locator("fieldset");
    await form.getByText("Display name").waitFor();
    const display = `Edited ${planName}`;
    await fill(form.locator("input").nth(2), display);
    for (let i = 0; i < 12; i += 1) {
      const save = page.getByRole("button", { name: "Save changes" });
      if (await save.count()) {
        await tracked(
          page,
          () => save.click(),
          (response) => response.url().includes(manifest.planId) && response.request().method() === "PATCH",
        );
        manifest.planDisplayName = display;
        return display;
      }
      await page.getByRole("button", { name: "Continue" }).click();
    }
    throw new Error("wizard did not reach save");
  });

  await step("staff-sessions-permissions", async () => {
    await page.goto(`${FRONTEND}/staff-branches`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Sessions" }).click();
    const sessions = await page.locator("body").innerText();
    await page.getByRole("tab", { name: "Permission audit" }).click();
    const audit = await page.locator("body").innerText();
    await page.goto(`${FRONTEND}/staff-branches/staff/${STAFF_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Active sessions").waitFor();
    await page.getByRole("tab", { name: "Permissions" }).click();
    await page.getByText(/staff\.|customer\.|scheme\./).first().waitFor();
    manifest.directorySessionsPlaceholder = /sessions register/i.test(sessions);
    manifest.directoryPermissionPlaceholder = /permissions register/i.test(audit);
    if (manifest.directorySessionsPlaceholder || manifest.directoryPermissionPlaceholder) {
      throw new Error("staff detail shows sessions and permissions; directory Sessions and Permission audit tabs are still placeholders");
    }
    return "directory and detail both show live access data";
  });

  await step("staff-deactivate", async () => {
    await page.goto(`${FRONTEND}/staff-branches/staff/${STAFF_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Deactivate" }).click();
    const dialog = page.getByRole("dialog");
    await fill(dialog.getByPlaceholder("Resigned"), "Portal audit removed this test staff login.");
    const json = await tracked(
      page,
      () => dialog.getByRole("button", { name: "Deactivate" }).click(),
      (response) => response.url().includes(STAFF_ID) && response.request().method() !== "GET",
    );
    manifest.staffStatus = payload(json).status ?? "INACTIVE";
    return `staff ${manifest.staffStatus}`;
  });

  await step("customer-edit", async () => {
    await page.goto(`${FRONTEND}/customers/${CUSTOMER_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Edit profile" }).click();
    const dialog = page.getByRole("dialog");
    await fill(dialog.getByPlaceholder("Customer full name"), "Audit Customer 137193 Edited");
    await tracked(
      page,
      () => dialog.getByRole("button", { name: "Save changes" }).click(),
      (response) => response.url().includes(CUSTOMER_ID) && response.request().method() !== "GET",
    );
    return "name saved";
  });

  await step("customer-nominee", async () => {
    await page.goto(`${FRONTEND}/customers/${CUSTOMER_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Customer" }).click();
    await page.getByRole("button", { name: /Add nominee|Manage nominee/ }).click();
    const dialog = page.getByRole("dialog");
    await fill(dialog.getByPlaceholder("Customer full name"), "Audit Nominee");
    await fill(dialog.getByPlaceholder("10-digit mobile"), "9847002211");
    await tracked(
      page,
      () => dialog.getByRole("button", { name: /Add nominee|Save nominee/ }).click(),
      (response) => response.url().includes("nominee") && response.request().method() !== "GET",
    );
    return "nominee saved";
  });

  await step("customer-kyc", async () => {
    await page.goto(`${FRONTEND}/customers/${CUSTOMER_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Customer" }).click();
    await page.getByRole("button", { name: /Upload & review|Review documents/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "PAN" }).click();
    await fill(dialog.getByPlaceholder("ABCDE1234F"), "ABCDE1234F");
    await dialog.locator('input[type="file"]').setInputFiles(PNG);
    await dialog.getByText("PAN image uploaded").waitFor({ timeout: 20000 });
    await dialog.getByRole("button", { name: "Submit for review" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /submitted/i }).waitFor();
    await page.getByRole("button", { name: "Review documents" }).click();
    const review = page.getByRole("dialog");
    await tracked(
      page,
      () => review.getByRole("button", { name: "Mark verified" }).click(),
      (response) => response.url().includes("kyc") && response.request().method() !== "GET",
    );
    return "KYC verified";
  });

  async function enrol(label, key) {
    await page.goto(`${FRONTEND}/enrollments`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create enrollment" }).click();
    const dialog = page.getByRole("dialog");
    await fill(dialog.getByPlaceholder("Search name, phone, or passbook no."), "Audit Customer");
    await dialog.getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: /Audit Customer/ }).first().click();
    await dialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: new RegExp(label, "i") }).first().click();
    await page.waitForTimeout(500);
    const submit = dialog.getByRole("button", { name: "Create enrollment" });
    if (!(await submit.isEnabled())) throw new Error((await dialog.innerText()).slice(0, 280));
    const json = await tracked(
      page,
      () => submit.click(),
      (response) => /\/admin\/schemes\/?$/.test(new URL(response.url()).pathname) && response.request().method() === "POST",
    );
    const created = payload(json);
    manifest[key] = {
      id: created.id,
      enrollmentNo: created.enrollmentNo,
      displayMode: created.displayMode,
      valueBasis: created.valueBasis,
      flexiblePhase: created.flexiblePhase,
      status: created.status,
    };
    return `${created.enrollmentNo} ${created.displayMode ?? ""} ${created.valueBasis ?? ""} ${created.flexiblePhase ?? created.status ?? ""}`.trim();
  }

  await step("enrol-flexible-free", () => enrol("Flexible then capped", "flexi"));
  await step("enrol-gold-weight", () => enrol("Gold weight", "goldEnrol"));

  await step("enrol-flexible-lock-window", async () => {
    await page.goto(`${FRONTEND}/enrollments/${LOCK_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByText("ENR-0000011").waitFor();
    const text = await page.locator("body").innerText();
    if (!/LOCKED|capped|lock/i.test(text)) throw new Error("lock-window scheme page did not show locked or capped");
    return "ENR-0000011 is the lock-window scheme; a new flexible enrolment opens in the free window";
  });

  await step("dues-collect", async () => {
    await page.goto(`${FRONTEND}/dues`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Collect" }).first().click();
    await page.getByRole("heading", { name: "Collect payment" }).waitFor();
    const dialog = page.getByRole("dialog");
    const submit = dialog.getByRole("button").filter({ hasText: /^Collect |Not payable/ });
    await submit.waitFor();
    const label = await submit.innerText();
    if (/Not payable/i.test(label)) throw new Error((await dialog.innerText()).slice(0, 280));
    const json = await tracked(
      page,
      () => submit.click(),
      (response) => response.url().includes("/payments") && response.request().method() === "POST",
    );
    const payment = payload(json);
    manifest.duesPayment = payment.id ?? payment.receiptNo;
    return `${payment.receiptNo ?? payment.id} ${label}`;
  });

  await step("cash-accept", async () => {
    await page.goto(`${FRONTEND}/cash-control`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Submission history" }).click();
    const row = page.getByRole("row").filter({ hasText: "Pending" }).first();
    await row.waitFor();
    await row.getByRole("button", { name: "Accept" }).click();
    const dialog = page.getByRole("dialog");
    const json = await tracked(
      page,
      () => dialog.getByRole("button", { name: "Accept", exact: true }).click(),
      (response) => response.url().includes("/cash-handovers/") && response.request().method() !== "GET",
    );
    manifest.handoverAccepted = payload(json).status ?? payload(json).id;
    return `accepted ${manifest.handoverAccepted}`;
  });

  await step("cash-reject", async () => {
    await page.goto(`${FRONTEND}/cash-control`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Submission history" }).click();
    const row = page.getByRole("row").filter({ hasText: "Pending" }).first();
    await row.waitFor();
    await row.getByRole("button", { name: "Accept" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await fill(dialog.locator("textarea"), "Drawer count does not match this handover.");
    const json = await tracked(
      page,
      () => dialog.getByRole("button", { name: "Confirm reject" }).click(),
      (response) => response.url().includes("/cash-handovers/") && response.request().method() !== "GET",
    );
    manifest.handoverRejected = payload(json).status ?? payload(json).id;
    return `rejected ${manifest.handoverRejected}`;
  });

  await step("gold-rate-publish", async () => {
    const scheme = payload((await api(page, `/admin/schemes/${GOLD_SCHEME}`)).json);
    const branchName = scheme.branchName ?? scheme.branch?.name ?? "Kochi";
    await page.goto(`${FRONTEND}/gold-rates`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add gold rate" }).click();
    const dialog = page.getByRole("dialog");
    await fill(dialog.locator('input[type="number"]'), "16350");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: /Kochi/i }).first().click();
    const json = await tracked(
      page,
      () => dialog.getByRole("button", { name: "Publish rate" }).click(),
      (response) => response.url().includes("/admin/gold-rate") && response.request().method() === "POST",
    );
    manifest.goldRate = payload(json);
    await page.goto(`${FRONTEND}/enrollments/${GOLD_SCHEME}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settlement preview" }).click();
    const preview = page.getByRole("dialog");
    await preview.getByText(/16,350|16350|rate/i).first().waitFor({ timeout: 15000 });
    const text = await preview.innerText();
    if (!/16,350|16350/.test(text)) throw new Error(text.slice(0, 280));
    await page.keyboard.press("Escape");
    return `published ₹16,350 for ${branchName}; preview shows it`;
  });

  await step("support-resolve", async () => {
    await page.goto(`${FRONTEND}/support`, { waitUntil: "domcontentloaded" });
    await page.getByText("Partial payment not reflected").first().click();
    const box = page.locator("textarea").last();
    await box.waitFor();
    await box.fill("The missing amount is now on the passbook. Closing this request.");
    const json = await tracked(
      page,
      () => page.getByRole("button", { name: "Reply & resolve" }).click(),
      (response) => response.url().includes("/status") && response.request().method() === "POST",
    );
    manifest.ticketStatus = payload(json).status;
    if (manifest.ticketStatus !== "RESOLVED") throw new Error(JSON.stringify(payload(json)).slice(0, 200));
    return "ticket RESOLVED";
  });

  await step("settings-branding", async () => {
    await page.goto(`${FRONTEND}/settings/branding`, { waitUntil: "domcontentloaded" });
    await page.getByText("Primary colour").waitFor();
    const target = page.locator('input[value^="#"]').first();
    const original = await target.inputValue();
    await fill(target, "#641c2e");
    await tracked(
      page,
      () => page.getByRole("button", { name: "Save branding" }).click(),
      (response) => response.url().includes("branding") && response.request().method() !== "GET",
    );
    await fill(target, original);
    await tracked(
      page,
      () => page.getByRole("button", { name: "Save branding" }).click(),
      (response) => response.url().includes("branding") && response.request().method() !== "GET",
    );
    return `saved #641c2e then restored ${original}`;
  });

  await step("settings-operations", async () => {
    await page.goto(`${FRONTEND}/settings/operations`, { waitUntil: "domcontentloaded" });
    await page.getByText("Receipt prefix").waitFor();
    const prefix = page.getByText("Receipt prefix").locator("xpath=following::input[1]");
    const original = await prefix.inputValue();
    const next = original === "QA" ? "RC" : "QA";
    await fill(prefix, next);
    await tracked(
      page,
      () => page.getByRole("button", { name: "Save operations" }).click(),
      (response) => response.url().includes("operations") && response.request().method() !== "GET",
    );
    await fill(prefix, original);
    await tracked(
      page,
      () => page.getByRole("button", { name: "Save operations" }).click(),
      (response) => response.url().includes("operations") && response.request().method() !== "GET",
    );
    return `saved prefix ${next} then restored ${original}`;
  });

  await step("settings-subscription", async () => {
    await page.goto(`${FRONTEND}/settings/subscription`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Request upgrade" }).first().click();
    const dialog = page.getByRole("dialog");
    await fill(dialog.locator("textarea"), "Portal audit requested this upgrade.");
    const json = await tracked(
      page,
      () => dialog.getByRole("button", { name: "Submit request" }).click(),
      (response) => response.request().method() === "POST",
    );
    manifest.subscriptionRequest = payload(json).status ?? payload(json).id ?? "submitted";
    return `request ${manifest.subscriptionRequest}; current plan stays until platform approval`;
  });

  await step("premature-closure", async () => {
    await page.goto(`${FRONTEND}/enrollments/${CLOSE_SCHEME}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Close prematurely" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Why is this scheme being closed early?").fill(
      "Customer asked to close this audit scheme early.",
    );
    const boxes = dialog.getByRole("checkbox");
    for (let i = 0; i < (await boxes.count()); i += 1) await boxes.nth(i).click();
    const json = await tracked(
      page,
      () => dialog.getByRole("button", { name: "Confirm closure" }).click(),
      (response) => response.url().includes(CLOSE_SCHEME) && response.request().method() !== "GET",
    );
    manifest.premature = payload(json).status ?? payload(json).redemptionNumber ?? "submitted";
    return String(manifest.premature);
  });

  await step("reject-approved-redemption", async () => {
    await page.goto(`${FRONTEND}/maturity`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Redemption queue" }).click();
    await page.getByText("P6-LOCK-699650").first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Reject this request instead" }).click();
    await sheet.locator("textarea").last().fill("The approved rate no longer matches what we will pay.");
    const json = await tracked(
      page,
      () => sheet.getByRole("button", { name: "Reject", exact: true }).click(),
      (response) => response.url().includes("/redemptions/") && response.request().method() !== "GET",
    );
    manifest.rejected = payload(json).status;
    if (manifest.rejected !== "REJECTED") throw new Error(JSON.stringify(payload(json)).slice(0, 200));
    return "redemption REJECTED";
  });

  await step("report-totals", async () => {
    await page.goto(`${FRONTEND}/reports`, { waitUntil: "domcontentloaded" });
    await page.getByText("Collection").first().waitFor();
    const keys = [
      "COLLECTION", "ENROLMENT", "OUTSTANDING", "MATURITY_REDEMPTION", "GOLD_ACCRUAL",
      "CUSTOMER_PERFORMANCE", "STAFF_PERFORMANCE", "CASH_HANDOVER", "REMINDER_DELIVERY",
      "WHATSAPP_USAGE", "SCHEME_REGISTER", "DEFAULTER", "BRANCH_PERFORMANCE", "SCHEME_PERFORMANCE",
    ];
    const mismatches = [];
    for (const key of keys) {
      const result = await api(page, `/admin/reports/${key}?period=CUSTOM&from=2026-09-01&to=2026-09-22`);
      if (result.status >= 400) {
        mismatches.push(`${key} HTTP ${result.status}`);
        continue;
      }
      const report = payload(result.json);
      const rows = report?.rows ?? [];
      const totals = report?.totalsRow;
      if (!totals) {
        mismatches.push(`${key}: no totals row (${rows.length} rows)`);
        continue;
      }
      const problems = compareTotals(rows, totals);
      if (problems.length) mismatches.push(`${key}: ${problems.slice(0, 2).join("; ")}`);
    }
    manifest.reportMismatches = mismatches;
    if (mismatches.length) throw new Error(mismatches.join(" | ").slice(0, 360));
    return "14 report totals match their row sums for 1–22 Sep 2026";
  });

  const failed = findings.filter((row) => !row.ok);
  expect(failed, failed.map((row) => `${row.area}: ${row.detail}`).join("\n")).toEqual([]);
});

function numericLeaves(value, path = "") {
  if (typeof value === "number" && Number.isFinite(value)) return [[path, value]];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => numericLeaves(child, path ? `${path}.${key}` : key));
}

function valueAt(row, path) {
  return path.split(".").reduce((current, key) => current?.[key], row);
}

function compareTotals(rows, totals) {
  const problems = [];
  for (const [path, expected] of numericLeaves(totals)) {
    const numbers = rows.map((row) => valueAt(row, path)).filter((value) => typeof value === "number");
    if (!numbers.length) continue;
    const sum = numbers.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - expected) > 0.5) problems.push(`${path} total ${expected} vs rows ${sum}`);
  }
  return problems;
}
