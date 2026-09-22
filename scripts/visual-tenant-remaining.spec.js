/**
 * Remaining KAIRALI tenant-portal actions, except reminders.
 * Each step records pass/fail and continues. Database checks follow in
 * scripts/verify-tenant-remaining.js.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const API = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const OUT = "/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend/docs/tenant-remaining-results.json";
const PNG = "/tmp/swarna-audit-kyc.png";

fs.writeFileSync(
  PNG,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const findings = [];
const manifest = {};

function record(area, ok, detail, extra) {
  const row = { area, ok, detail, ...extra };
  findings.push(row);
  fs.writeFileSync(OUT, JSON.stringify({ findings, manifest }, null, 2));
  console.log(`${ok ? "OK" : "FAIL"} ${area}: ${detail}`);
}

async function fillControlled(locator, value) {
  await locator.waitFor({ state: "visible", timeout: 15000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await locator.click();
    await locator.fill(String(value));
    if ((await locator.inputValue()) === String(value)) return;
    await locator.page().waitForTimeout(300);
  }
  throw new Error(`Input did not keep "${value}"`);
}

async function login(page) {
  await page.goto(`${FRONTEND}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await fillControlled(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fillControlled(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
}

async function tokenOf(page) {
  return page.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
}

async function api(page, path, { method = "GET", body } = {}) {
  const token = await tokenOf(page);
  const response = await page.request.fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    data: body,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status(), json };
}

function dataOf(json) {
  return json?.data ?? json;
}

async function toastText(page) {
  const toast = page.locator("[data-sonner-toast]").last();
  await toast.waitFor({ state: "visible", timeout: 12000 });
  return toast.innerText();
}

async function runStep(area, fn) {
  try {
    const detail = await fn();
    record(area, true, detail || "done");
  } catch (error) {
    record(area, false, String(error?.message ?? error).slice(0, 500));
  }
}

test.use({ actionTimeout: 20000, navigationTimeout: 30000 });

test("remaining tenant portal actions except reminders", async ({ page }) => {
  test.setTimeout(420000);
  await login(page);

  const stamp = String(Date.now()).slice(-5);
  const planCode = `AU${stamp}`;
  const planName = `Audit Plan ${planCode}`;
  const branchCode = `B${stamp.slice(0, 5)}`;
  const branchName = `Audit Branch ${branchCode}`;

  await runStep("scheme-create", async () => {
    await page.goto(`${FRONTEND}/schemes/new`, { waitUntil: "domcontentloaded" });
    await page.getByText("Plan name").waitFor({ timeout: 15000 });
    const inputs = page.locator("input:not([type=hidden])");
    await fillControlled(inputs.nth(0), planName);
    await fillControlled(inputs.nth(1), planCode);
    for (let step = 0; step < 12; step += 1) {
      const create = page.getByRole("button", { name: "Create draft" });
      if (await create.count()) {
        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().includes("/admin/scheme-plans") &&
            response.request().method() === "POST",
          { timeout: 20000 },
        );
        await create.click();
        const response = await responsePromise;
        const body = await response.json().catch(() => ({}));
        if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
        const created = dataOf(body);
        manifest.planId = created.id ?? created._id;
        manifest.planCode = planCode;
        await page.waitForURL(/\/schemes\/spl_/, { timeout: 15000 });
        return `draft ${manifest.planId} code ${planCode}`;
      }
      const next = page.getByRole("button", { name: "Continue" });
      await next.click();
      await page.waitForTimeout(250);
      const err = page.locator("[data-sonner-toast]").last();
      if (await err.count()) {
        const text = await err.innerText().catch(() => "");
        if (/highlighted|could not|error/i.test(text)) throw new Error(text);
      }
    }
    throw new Error("plan wizard did not reach Create draft");
  });

  await runStep("scheme-edit", async () => {
    if (!manifest.planId) throw new Error("plan was not created");
    await page.goto(`${FRONTEND}/schemes/${manifest.planId}/edit`, { waitUntil: "domcontentloaded" });
    await page.getByText("Display name").waitFor({ timeout: 15000 });
    const display = `Edited ${planName}`;
    await fillControlled(page.locator("input:not([type=hidden])").nth(2), display);
    for (let step = 0; step < 12; step += 1) {
      const save = page.getByRole("button", { name: "Save changes" });
      if (await save.count() && (await save.isEnabled())) {
        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().includes(`/admin/scheme-plans/${manifest.planId}`) &&
            response.request().method() === "PATCH",
          { timeout: 20000 },
        );
        await save.click();
        const response = await responsePromise;
        const body = await response.json().catch(() => ({}));
        if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
        manifest.planDisplayName = display;
        const saved = await toastText(page);
        if (!/updated/i.test(saved)) throw new Error(saved);
        return `display name saved as ${display}`;
      }
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForTimeout(200);
    }
    throw new Error("edit wizard did not reach Save changes");
  });

  await runStep("branch-create-address", async () => {
    await page.goto(`${FRONTEND}/staff-branches`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add branch" }).click();
    const dialog = page.getByRole("dialog");
    const inputs = dialog.locator("input");
    await fillControlled(inputs.nth(0), branchName);
    await fillControlled(inputs.nth(1), branchCode);
    await fillControlled(inputs.nth(2), "Audit Lane 12");
    await fillControlled(inputs.nth(3), "Kochi");
    await fillControlled(inputs.nth(4), "682020");
    await fillControlled(inputs.nth(5), "9847003344");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/admin/branches") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Create branch" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    const created = dataOf(body);
    manifest.branchId = created.id ?? created._id;
    manifest.branchCode = branchCode;
    manifest.branchAddress = created.address;
    const posted = response.request().postDataJSON();
    if (!posted.address || typeof posted.address === "string") {
      throw new Error(`portal sent address ${JSON.stringify(posted.address)}`);
    }
    return `saved ${manifest.branchId} address ${JSON.stringify(posted.address)}`;
  });

  await runStep("branch-edit", async () => {
    if (!manifest.branchId) throw new Error("branch was not created");
    await page.goto(`${FRONTEND}/staff-branches/branches/${manifest.branchId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Edit branch" }).click();
    const dialog = page.getByRole("dialog");
    const edited = `${branchName} Edited`;
    await fillControlled(dialog.locator("input").nth(0), edited);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/admin/branches/${manifest.branchId}`) &&
        ["PATCH", "PUT"].includes(response.request().method()),
    );
    await dialog.getByRole("button", { name: "Save changes" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.branchEditedName = edited;
    return `renamed to ${edited}`;
  });

  await runStep("branch-deactivate", async () => {
    if (!manifest.branchId) throw new Error("branch was not created");
    await page.getByRole("button", { name: "Deactivate branch" }).click();
    const dialog = page.getByRole("dialog");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(manifest.branchId) && response.request().method() !== "GET",
    );
    await dialog.getByRole("button", { name: "Deactivate" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.branchDeactivated = true;
    return "branch deactivated";
  });

  await runStep("staff-edit", async () => {
    const list = await api(page, "/admin/staff?limit=50");
    const rows = dataOf(list.json)?.items ?? dataOf(list.json) ?? [];
    const staff = (Array.isArray(rows) ? rows : []).find((row) =>
      String(row.name ?? "").includes("Audit Staff"),
    );
    if (!staff) throw new Error("Audit Staff was not in the staff list");
    manifest.staffId = staff.id;
    await page.goto(`${FRONTEND}/staff-branches/staff/${staff.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Edit profile" }).click();
    const dialog = page.getByRole("dialog");
    const edited = "Audit Staff 137193 Edited";
    await fillControlled(dialog.locator("input").first(), edited);
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(staff.id) && response.request().method() !== "GET",
    );
    await dialog.getByRole("button", { name: "Save changes" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.staffEditedName = edited;
    return `renamed ${staff.id}`;
  });

  await runStep("staff-sessions-and-permissions", async () => {
    await page.goto(`${FRONTEND}/staff-branches`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Sessions" }).click();
    const sessionsText = await page.locator("body").innerText();
    const sessionsPlaceholder = /sessions register/i.test(sessionsText);
    await page.getByRole("tab", { name: "Permission audit" }).click();
    const auditText = await page.locator("body").innerText();
    const auditPlaceholder = /permissions register/i.test(auditText);
    if (!manifest.staffId) throw new Error("staff id missing");
    await page.goto(`${FRONTEND}/staff-branches/staff/${manifest.staffId}`, {
      waitUntil: "domcontentloaded",
    });
    const detail = await page.locator("body").innerText();
    if (!/Active sessions/i.test(detail)) throw new Error("staff detail has no Active sessions");
    await page.getByRole("tab", { name: "Permissions" }).click();
    const perms = await page.locator("body").innerText();
    manifest.sessionsTabPlaceholder = sessionsPlaceholder;
    manifest.permissionAuditPlaceholder = auditPlaceholder;
    manifest.staffPermissionText = /staff\.|customer\.|scheme\./i.test(perms);
    if (sessionsPlaceholder || auditPlaceholder) {
      throw new Error(
        `directory tabs are placeholders (sessions=${sessionsPlaceholder}, permission audit=${auditPlaceholder}); staff detail permissions visible=${manifest.staffPermissionText}`,
      );
    }
    return "sessions and permission audit show live rows";
  });

  await runStep("staff-deactivate", async () => {
    if (!manifest.staffId) throw new Error("staff id missing");
    await page.goto(`${FRONTEND}/staff-branches/staff/${manifest.staffId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Deactivate" }).click();
    const dialog = page.getByRole("dialog");
    await fillControlled(dialog.locator("textarea").first(), "Portal audit deactivated this test staff member.");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(manifest.staffId) && response.request().method() !== "GET",
    );
    await dialog.getByRole("button", { name: "Deactivate" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.staffDeactivated = true;
    return "staff deactivated";
  });

  await runStep("customer-edit", async () => {
    const found = await api(page, "/admin/customers?q=137193&limit=5");
    const items = dataOf(found.json)?.items ?? [];
    const customer = items.find((row) => String(row.name).includes("Audit Customer"));
    if (!customer) throw new Error("Audit Customer 137193 was not found");
    manifest.customerId = customer.id;
    await page.goto(`${FRONTEND}/customers/${customer.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Edit profile" }).click();
    const dialog = page.getByRole("dialog");
    const edited = "Audit Customer 137193 Edited";
    await fillControlled(dialog.getByPlaceholder("Customer full name"), edited);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/admin/customers/${customer.id}`) &&
        response.request().method() !== "GET",
    );
    await dialog.getByRole("button", { name: "Save changes" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.customerEditedName = edited;
    return `customer ${customer.id} renamed`;
  });

  await runStep("customer-nominee", async () => {
    if (!manifest.customerId) throw new Error("customer id missing");
    await page.goto(`${FRONTEND}/customers/${manifest.customerId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Customer" }).click();
    await page.getByRole("button", { name: /Add nominee|Manage nominee/ }).click();
    const dialog = page.getByRole("dialog");
    await fillControlled(dialog.getByPlaceholder("Customer full name"), "Audit Nominee");
    await fillControlled(dialog.getByPlaceholder("10-digit mobile"), "9847002211");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("nominee") && response.request().method() !== "GET",
    );
    await dialog.getByRole("button", { name: /Add nominee|Save nominee/ }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.nomineeName = "Audit Nominee";
    return "nominee saved";
  });

  await runStep("customer-kyc", async () => {
    if (!manifest.customerId) throw new Error("customer id missing");
    await page.goto(`${FRONTEND}/customers/${manifest.customerId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Customer" }).click();
    await page.getByRole("button", { name: /Upload & review|Review documents|View KYC/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "PAN" }).click();
    await fillControlled(dialog.getByPlaceholder("ABCDE1234F"), "ABCDE1234F");
    await dialog.locator('input[type="file"]').setInputFiles(PNG);
    await expect(dialog.getByText("PAN image uploaded")).toBeVisible({ timeout: 20000 });
    await dialog.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /submitted/i })).toBeVisible();
    await page.getByRole("button", { name: /Upload & review|Review documents/ }).click();
    const review = page.getByRole("dialog");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("kyc") && response.request().method() !== "GET",
    );
    await review.getByRole("button", { name: "Mark verified" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.kycVerified = true;
    return "KYC uploaded and marked verified";
  });

  async function enrol(planLabel, key) {
    await page.goto(`${FRONTEND}/enrollments`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create enrollment" }).click();
    const dialog = page.getByRole("dialog");
    await fillControlled(dialog.getByPlaceholder("Search name, phone, or passbook no."), "137193");
    await page.waitForTimeout(800);
    await dialog.getByRole("combobox").nth(0).click();
    await page.getByRole("option", { name: /Audit Customer/ }).first().click();
    await dialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: new RegExp(planLabel, "i") }).first().click();
    await page.waitForTimeout(600);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/admin/schemes") && response.request().method() === "POST",
      { timeout: 25000 },
    );
    const submit = dialog.getByRole("button", { name: "Create enrollment" });
    if (!(await submit.isEnabled())) {
      throw new Error((await dialog.innerText()).slice(0, 400));
    }
    await submit.click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 400));
    const created = dataOf(body);
    manifest[key] = {
      id: created.id ?? created._id,
      enrollmentNo: created.enrollmentNo ?? created.enrollmentNumber,
      displayMode: created.displayMode,
      paymentPattern: created.paymentPattern,
      flexiblePhase: created.flexiblePhase,
      valueBasis: created.valueBasis,
      status: created.status,
    };
    await page.waitForURL(/\/enrollments\/sch_/, { timeout: 20000 });
    return `${manifest[key].enrollmentNo} ${created.displayMode ?? created.paymentPattern} ${created.valueBasis ?? ""} ${created.flexiblePhase ?? ""}`.trim();
  }

  await runStep("enrol-flexible-free", () => enrol("Flexible then capped", "flexi"));
  await runStep("enrol-gold-weight", () => enrol("Gold weight", "goldEnrol"));

  await runStep("enrol-flexible-lock-window", async () => {
    const locked = await api(page, "/admin/schemes?limit=50");
    const items = dataOf(locked.json)?.items ?? [];
    const row = items.find(
      (item) => item.displayMode === "FLEXIBLE_LOCK_WINDOW" || item.flexiblePhase === "CAPPED",
    );
    if (!row) throw new Error("no locked flexible scheme is on the tenant list");
    await page.goto(`${FRONTEND}/enrollments/${row.id}`, { waitUntil: "domcontentloaded" });
    const text = await page.locator("body").innerText();
    manifest.lockWindow = { id: row.id, enrollmentNo: row.enrollmentNo, displayMode: row.displayMode };
    if (!/lock|capped|LOCKED/i.test(text) && row.displayMode !== "FLEXIBLE_LOCK_WINDOW") {
      throw new Error(`page did not show a lock-window scheme: ${row.enrollmentNo}`);
    }
    return `new flexible enrolment starts in the free window; existing ${row.enrollmentNo} is ${row.displayMode ?? row.status}`;
  });

  await runStep("collect-later-instalment", async () => {
    await page.goto(`${FRONTEND}/enrollments/sch_01M346YZW09TD8F3E3JKVK9FEH`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Collect payment" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Collect / }).waitFor({ timeout: 15000 });
    const label = await dialog.getByRole("button", { name: /^Collect / }).innerText();
    if (/Not payable/i.test(label)) throw new Error(await dialog.innerText());
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/payments") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: /^Collect / }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    const payment = dataOf(body);
    manifest.laterPayment = {
      id: payment.id,
      amount: payment.amount ?? payment.amountPaise,
      receiptNo: payment.receiptNo,
      schemeId: "sch_01M346YZW09TD8F3E3JKVK9FEH",
    };
    return `${payment.receiptNo ?? payment.id} collected (${label})`;
  });

  await runStep("dues-collect", async () => {
    await page.goto(`${FRONTEND}/dues`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Collect" }).first().click();
    const dialog = page.getByRole("dialog");
    const submit = dialog.getByRole("button", { name: /^Collect / });
    await submit.waitFor({ timeout: 15000 });
    const label = await submit.innerText();
    if (/Not payable/i.test(label)) throw new Error((await dialog.innerText()).slice(0, 300));
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/payments") && response.request().method() === "POST",
    );
    await submit.click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    const payment = dataOf(body);
    manifest.duesPayment = { id: payment.id, receiptNo: payment.receiptNo, amount: payment.amount };
    return `${payment.receiptNo ?? payment.id} from dues (${label})`;
  });

  await runStep("cash-accept", async () => {
    await page.goto(`${FRONTEND}/cash-control`, { waitUntil: "domcontentloaded" });
    const row = page.getByRole("row").filter({ hasText: "PENDING" }).first();
    await row.waitFor({ timeout: 15000 });
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/cash-handovers") && response.request().method() !== "GET",
    );
    await row.getByRole("button", { name: "Accept" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Accept", exact: true }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.handoverAccepted = dataOf(body)?.id ?? true;
    return "pending handover accepted";
  });

  await runStep("cash-reject", async () => {
    await page.goto(`${FRONTEND}/cash-control`, { waitUntil: "domcontentloaded" });
    const row = page.getByRole("row").filter({ hasText: "PENDING" }).first();
    await row.waitFor({ timeout: 15000 });
    await row.getByRole("button", { name: "Accept" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await fillControlled(dialog.locator("textarea").first(), "Drawer count does not match this handover.");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/cash-handovers") && response.request().method() !== "GET",
    );
    await dialog.getByRole("button", { name: "Confirm reject" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.handoverRejected = dataOf(body)?.id ?? true;
    return "pending handover rejected";
  });

  await runStep("gold-rate-publish", async () => {
    const scheme = await api(page, "/admin/schemes/sch_01M33YWCS4R9TMY9WHAAFMASSW");
    const schemeBody = dataOf(scheme.json);
    const branchId = schemeBody.branchId ?? schemeBody.branch?.id;
    const branchName = schemeBody.branch?.name ?? schemeBody.branchName ?? "Kochi Showroom";
    manifest.goldSchemeBranch = { branchId, branchName, enrollmentNo: schemeBody.enrollmentNo };
    await page.goto(`${FRONTEND}/gold-rates`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add gold rate" }).click();
    const dialog = page.getByRole("dialog");
    await fillControlled(dialog.locator('input[type="number"]'), "16350");
    await dialog.getByRole("combobox").click();
    const option = page.getByRole("option", { name: new RegExp(branchName.split("—")[0].trim(), "i") });
    if (await option.count()) await option.first().click();
    else await page.getByRole("option", { name: /Kochi/i }).first().click();
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/gold-rates") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Publish rate" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.goldRate = dataOf(body);
    await page.goto(`${FRONTEND}/enrollments/sch_01M33YWCS4R9TMY9WHAAFMASSW`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Settlement preview" }).click();
    const preview = page.getByRole("dialog");
    await preview.waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const text = await preview.innerText();
    manifest.goldPreviewText = text.slice(0, 500);
    const usesNewRate = /16,350|16350/.test(text);
    await preview.getByRole("button", { name: "Cancel" }).click().catch(async () => {
      await page.keyboard.press("Escape");
    });
    if (!usesNewRate) throw new Error(`preview did not show ₹16,350: ${text.slice(0, 300)}`);
    return `published 16350 for ${branchName}; preview uses it`;
  });

  await runStep("support-resolve", async () => {
    await page.goto(`${FRONTEND}/support`, { waitUntil: "domcontentloaded" });
    await page.getByText("Flow ticket 2765").first().click();
    const sheet = page.locator("[role=dialog], [data-state=open]").last();
    await sheet.locator("textarea").last().fill("Receipt copy has been shared with the customer.");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/grievances") && response.request().method() !== "GET",
    );
    await page.getByRole("button", { name: "Reply & resolve" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.ticketResolved = dataOf(body)?.status ?? "RESOLVED";
    return `ticket ${manifest.ticketResolved}`;
  });

  await runStep("settings-profile", async () => {
    await page.goto(`${FRONTEND}/settings`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Profile" }).click();
    const display = page.locator("input").nth(1);
    const original = await display.inputValue();
    manifest.profileDisplayOriginal = original;
    const next = original.endsWith(" QA") ? original : `${original} QA`;
    await fillControlled(display, next);
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/settings") && response.request().method() !== "GET",
    );
    await page.getByRole("button", { name: "Save profile" }).click();
    const response = await responsePromise;
    if (response.status() >= 400) throw new Error(JSON.stringify(await response.json()).slice(0, 300));
    await fillControlled(display, original);
    const restorePromise = page.waitForResponse(
      (response) => response.url().includes("/settings") && response.request().method() !== "GET",
    );
    await page.getByRole("button", { name: "Save profile" }).click();
    const restored = await restorePromise;
    if (restored.status() >= 400) throw new Error("profile restore failed");
    return `saved display name "${next}" then restored "${original}"`;
  });

  await runStep("settings-branding", async () => {
    await page.goto(`${FRONTEND}/settings`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Branding" }).click();
    const textColor = page.getByRole("textbox").first();
    const original = await textColor.inputValue();
    manifest.brandingOriginal = original;
    await fillControlled(textColor, "#641c2e");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("branding") && response.request().method() !== "GET",
    );
    await page.getByRole("button", { name: "Save branding" }).click();
    const response = await responsePromise;
    if (response.status() >= 400) throw new Error(JSON.stringify(await response.json()).slice(0, 300));
    await fillControlled(textColor, original || "#730321");
    const restorePromise = page.waitForResponse(
      (response) => response.url().includes("branding") && response.request().method() !== "GET",
    );
    await page.getByRole("button", { name: "Save branding" }).click();
    const restored = await restorePromise;
    if (restored.status() >= 400) throw new Error("branding restore failed");
    return `saved primary colour #641c2e then restored ${original}`;
  });

  await runStep("settings-operations", async () => {
    await page.goto(`${FRONTEND}/settings/operations`, { waitUntil: "domcontentloaded" });
    const prefix = page.locator("input").first();
    await prefix.waitFor({ timeout: 15000 });
    const original = await prefix.inputValue();
    manifest.receiptPrefixOriginal = original;
    const next = original === "QA" ? "RC" : "QA";
    await fillControlled(prefix, next);
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/settings") && response.request().method() !== "GET",
    );
    await page.getByRole("button", { name: "Save operations" }).click();
    const response = await responsePromise;
    if (response.status() >= 400) throw new Error(JSON.stringify(await response.json()).slice(0, 300));
    await fillControlled(prefix, original);
    const restorePromise = page.waitForResponse(
      (response) => response.url().includes("/settings") && response.request().method() !== "GET",
    );
    await page.getByRole("button", { name: "Save operations" }).click();
    const restored = await restorePromise;
    if (restored.status() >= 400) throw new Error("operations restore failed");
    return `saved receipt prefix "${next}" then restored "${original}"`;
  });

  await runStep("settings-subscription", async () => {
    await page.goto(`${FRONTEND}/settings/subscription`, { waitUntil: "domcontentloaded" });
    const upgrade = page.getByRole("button", { name: "Request upgrade" }).first();
    if (!(await upgrade.count())) {
      const text = await page.locator("body").innerText();
      throw new Error(`no upgrade request button. ${text.slice(0, 200)}`);
    }
    await upgrade.click();
    const dialog = page.getByRole("dialog");
    await fillControlled(dialog.locator("textarea"), "Portal audit requested this upgrade.");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("subscription") && response.request().method() !== "GET",
    );
    await dialog.getByRole("button", { name: "Submit request" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.subscriptionRequest = dataOf(body);
    return "upgrade request submitted; live plan is unchanged until platform approval";
  });

  await runStep("premature-closure", async () => {
    await page.goto(`${FRONTEND}/enrollments/sch_01M346YZW09TD8F3E3JKVK9FEH`, {
      waitUntil: "domcontentloaded",
    });
    const close = page.getByRole("button", { name: "Close prematurely" });
    if (!(await close.count())) throw new Error("Close prematurely is not available on ENR-0000038");
    await close.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Why is this scheme being closed early?").fill(
      "Customer asked to close this audit scheme early.",
    );
    const boxes = dialog.getByRole("checkbox");
    const count = await boxes.count();
    for (let i = 0; i < count; i += 1) await boxes.nth(i).click();
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("premature") || (response.url().includes("sch_01M346YZW09TD8F3E3JKVK9FEH") && response.request().method() !== "GET"),
    );
    await dialog.getByRole("button", { name: "Confirm closure" }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 400));
    manifest.premature = dataOf(body);
    return `closed ${manifest.premature?.redemptionNumber ?? manifest.premature?.status ?? "submitted"}`;
  });

  await runStep("reject-approved-redemption", async () => {
    await page.goto(`${FRONTEND}/maturity`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Redemption queue" }).click();
    await page.getByText("P6-LOCK-699650").first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Reject this request instead" }).click();
    await sheet.locator("textarea").last().fill("Rate on the approved snapshot is no longer the rate we will pay.");
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("redemptions") && response.request().method() !== "GET",
    );
    await sheet.getByRole("button", { name: /^Reject$/ }).click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    if (response.status() >= 400) throw new Error(JSON.stringify(body).slice(0, 300));
    manifest.rejectedRedemption = dataOf(body)?.status ?? "REJECTED";
    return `redemption ${manifest.rejectedRedemption}`;
  });

  await runStep("report-totals", async () => {
    await page.goto(`${FRONTEND}/reports`, { waitUntil: "domcontentloaded" });
    await page.getByText(/Collection|Report/).first().waitFor({ timeout: 15000 });
    const keys = [
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
    const mismatches = [];
    for (const key of keys) {
      const result = await api(
        page,
        `/admin/reports/${key}?period=CUSTOM&from=2026-09-01&to=2026-09-22`,
      );
      const report = dataOf(result.json);
      const rows = report?.rows ?? report?.table?.rows ?? [];
      const totals = report?.totalsRow;
      if (!totals) {
        mismatches.push(`${key}: no totals row (${rows.length} rows)`);
        continue;
      }
      const problems = compareTotals(rows, totals);
      if (problems.length) mismatches.push(`${key}: ${problems.join("; ")}`);
    }
    manifest.reportMismatches = mismatches;
    if (mismatches.length) throw new Error(mismatches.join(" | ").slice(0, 500));
    return "14 report totals match the sum of their rows for 1–22 Sep 2026";
  });

  const failed = findings.filter((row) => !row.ok);
  expect(failed, failed.map((row) => `${row.area}: ${row.detail}`).join("\n")).toEqual([]);
});

function numericLeaves(value, path = "") {
  if (typeof value === "number" && Number.isFinite(value)) return [[path, value]];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    numericLeaves(child, path ? `${path}.${key}` : key),
  );
}

function valueAt(row, path) {
  return path.split(".").reduce((current, key) => current?.[key], row);
}

function compareTotals(rows, totals) {
  const problems = [];
  for (const [path, expected] of numericLeaves(totals)) {
    if (path === "label" || path.endsWith(".label")) continue;
    const numbers = rows
      .map((row) => valueAt(row, path))
      .filter((value) => typeof value === "number");
    if (!numbers.length) continue;
    const sum = numbers.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - expected) > 0.5) {
      problems.push(`${path} total ${expected} vs row sum ${sum}`);
    }
  }
  return problems;
}
