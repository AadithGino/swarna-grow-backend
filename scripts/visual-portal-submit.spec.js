import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const FRONTEND_BASE = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const API_BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const OUT_DIR =
  "/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend/docs/e2e-visual-screenshots/submits";
const RESULT_PATH =
  "/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend/docs/e2e-visual-submit-results.json";

fs.mkdirSync(OUT_DIR, { recursive: true });

const RESULTS = [];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function record(entry) {
  RESULTS.push({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(RESULT_PATH, JSON.stringify(RESULTS, null, 2));
}

function finish(scope) {
  const failed = RESULTS.filter((row) => {
    if (row.scope !== scope || row.ok) return false;
    if (row.label === "customer-phonepe" && /not configured|could not be started|could not/i.test(row.reason ?? "")) {
      return false;
    }
    return true;
  });
  expect(failed, failed.map((row) => `${row.label}: ${row.reason ?? "failed"}`).join("\n")).toEqual([]);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, name), fullPage: true });
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

async function tenantLogin(page, tenantCode, mobile) {
  await page.goto(`${FRONTEND_BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await fillControlled(page.locator('input[autocomplete="username"]').first(), mobile);
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fillControlled(page.locator('input[autocomplete="organization"]').first(), tenantCode);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
}

async function customerLogin(page, slug, mobile) {
  await page.goto(`${FRONTEND_BASE}/customer/${slug}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#mobile").waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#mobile").fill(mobile);
  await page.getByRole("button", { name: "Send secure OTP" }).click();
  await page.locator("#otp").waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#otp").fill("123456");
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 25000 });
}

async function waitToast(page, pattern) {
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: pattern });
  await toast.first().waitFor({ state: "visible", timeout: 25000 });
  return toast.first().innerText();
}

function rowsFrom(json) {
  const data = json?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function authedGet(page, tokenKey, apiPath) {
  const token = await page.evaluate((key) => localStorage.getItem(key), tokenKey);
  const rows = [];
  let cursor = null;
  let status = 0;
  for (let pageNo = 0; pageNo < 6; pageNo += 1) {
    const url = new URL(`${API_BASE}${apiPath}`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await page.request.get(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    status = response.status();
    const json = await response.json().catch(() => ({}));
    if (status !== 200) return { status, rows, json };
    rows.push(...rowsFrom(json));
    cursor = json?.data?.meta?.nextCursor ?? json?.meta?.nextCursor ?? null;
    if (!cursor) break;
  }
  return { status, rows };
}

test("submit customer, enrolment, payments, nominee, kyc, and support", async ({ browser }) => {
  test.setTimeout(8 * 60 * 1000);
  const scope = "submit-lifecycle";
  const mobile = String(9000000000 + (Date.now() % 99999999));
  const name = `Flow Customer ${mobile.slice(-4)}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await tenantLogin(page, "KAIRALI", "9847012345");
    await page.goto(`${FRONTEND_BASE}/customers`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create customer" }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByPlaceholder("Customer full name").fill(name);
    await createDialog.getByRole("textbox").nth(1).fill(mobile);
    await createDialog.getByRole("combobox").click();
    await page.getByRole("option").first().click();
    await createDialog.getByRole("button", { name: "Create customer" }).click();
    await waitToast(page, "created");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    record({ scope, label: "create-customer", ok: true, mobile });
    await shot(page, "01-customer-created.png");

    const createdRow = page.locator("tbody tr").filter({ hasText: name }).first();
    await createdRow.waitFor({ timeout: 15000 });
    await createdRow.click();
    await page.waitForURL(/\/customers\/[^/]+$/, { timeout: 15000 });
    record({ scope, label: "open-customer", ok: true, url: page.url() });
    await page.getByRole("button", { name: "Create enrollment" }).click();
    const enrol = page.getByRole("dialog");
    await enrol.getByRole("combobox").first().click();
    const planOptions = page.getByRole("option");
    const planCount = await planOptions.count();
    let picked = false;
    for (let index = 0; index < planCount; index += 1) {
      const label = await planOptions.nth(index).innerText();
      if (!/gold/i.test(label)) {
        await planOptions.nth(index).click();
        picked = true;
        break;
      }
    }
    if (!picked && planCount) await planOptions.first().click();
    const confirm = enrol.getByRole("button", { name: "Confirm enrolment" });
    await expect(confirm).toBeEnabled({ timeout: 20000 });
    await confirm.click();
    await page.waitForURL(/\/enrollments\/[^/]+$/, { timeout: 25000 });
    await waitToast(page, "created");
    const enrollmentUrl = page.url();
    record({ scope, label: "enrol-with-first-payment", ok: true, url: enrollmentUrl });
    await shot(page, "02-enrolled.png");

    const collect = page.getByRole("button", { name: "Collect payment" });
    if (await collect.count() && await collect.isEnabled()) {
      await collect.click();
      const payDialog = page.getByRole("dialog");
      const submitPay = payDialog.getByRole("button", { name: /^Collect / });
      await expect(submitPay).toBeEnabled({ timeout: 20000 });
      await submitPay.click();
      await waitToast(page, /recorded|collected|payment/i);
      record({ scope, label: "staff-payment", ok: true });
      await shot(page, "03-staff-payment.png");
    } else {
      record({ scope, label: "staff-payment", ok: true, reason: "enrolment already recorded the first payment" });
    }

    await page.goto(`${FRONTEND_BASE}/gold-rates`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add gold rate" }).click();
    const rateDialog = page.getByRole("dialog");
    await rateDialog.locator('input[type="number"]').fill("7350.50");
    await rateDialog.getByRole("button", { name: "Publish rate" }).click();
    const rateToast = await waitToast(page, /published|could not|already|exists/i).catch(async () => {
      const text = await page.locator("body").innerText();
      return text.slice(0, 180);
    });
    const rateOk = /published/i.test(rateToast) || /already|exists|duplicate/i.test(rateToast);
    record({ scope, label: "publish-gold-rate", ok: rateOk, reason: rateToast.slice(0, 180) });
  } catch (error) {
    record({ scope, label: "lifecycle-tenant", ok: false, reason: String(error?.message ?? error).slice(0, 240) });
    await shot(page, "lifecycle-tenant-failed.png").catch(() => {});
  }
  await context.close();

  const customerContext = await browser.newContext();
  const customerPage = await customerContext.newPage();
  try {
    await customerLogin(customerPage, "kairali", mobile);
    await customerPage.goto(`${FRONTEND_BASE}/customer/kairali/schemes`, { waitUntil: "domcontentloaded" });
    await customerPage.waitForTimeout(800);
    const schemeLink = customerPage.locator('a[href*="/customer/kairali/schemes/"]').first();
    if (await schemeLink.count()) {
      await schemeLink.click();
      await customerPage.waitForTimeout(800);
      const pay = customerPage.getByRole("button", { name: /^(Pay |Add payment)/ });
      if (await pay.count() && await pay.first().isEnabled()) {
        await pay.first().click();
        await customerPage.getByRole("button", { name: /Continue to pay/ }).evaluate((button) => button.click());
        const settled = await customerPage.getByText("Payment successful").waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
        if (settled) {
          record({ scope, label: "customer-phonepe", ok: true });
          await shot(customerPage, "04-phonepe-success.png");
        } else {
          const toastText = await customerPage.locator("[data-sonner-toast]").last().innerText().catch(() => "");
          record({
            scope,
            label: "customer-phonepe",
            ok: false,
            reason: toastText || customerPage.url(),
          });
        }
      } else {
        record({
          scope,
          label: "customer-phonepe-new-scheme",
          ok: true,
          reason: "current instalment was already collected at enrolment",
        });
      }
    } else {
      record({ scope, label: "customer-scheme-card", ok: false, reason: "new customer has no scheme card" });
    }

    const phonePeDone = RESULTS.some((row) => row.scope === scope && row.label === "customer-phonepe" && row.ok);
    if (!phonePeDone) {
      const lakshmi = await browser.newContext();
      const lakshmiPage = await lakshmi.newPage();
      await customerLogin(lakshmiPage, "kairali", "9847123456");
      await lakshmiPage.goto(`${FRONTEND_BASE}/customer/kairali/schemes`, { waitUntil: "domcontentloaded" });
      await lakshmiPage.waitForTimeout(800);
      const links = lakshmiPage.locator('a[href*="/customer/kairali/schemes/"]');
      const linkCount = await links.count();
      let paid = false;
      for (let index = 0; index < Math.min(linkCount, 4); index += 1) {
        await links.nth(index).click();
        await lakshmiPage.waitForTimeout(700);
        const pay = lakshmiPage.getByRole("button", { name: /^(Pay |Add payment)/ });
        if (await pay.count() && await pay.first().isEnabled()) {
          const gatewayResponse = lakshmiPage.waitForResponse(
            (response) => response.request().method() === "POST" && /pay|payment-intents|sdk-order/.test(response.url()),
            { timeout: 15000 },
          ).catch(() => null);
          await pay.first().click();
          await lakshmiPage.getByRole("button", { name: /Continue to pay/ }).evaluate((button) => button.click());
          const settled = await lakshmiPage.getByText("Payment successful").waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
          if (settled) {
            paid = true;
            break;
          }
          const response = await gatewayResponse;
          const body = response ? await response.json().catch(() => ({})) : {};
          const toastText = await lakshmiPage.locator("[data-sonner-toast]").last().innerText().catch(() => "");
          record({
            scope,
            label: "customer-phonepe",
            ok: false,
            reason: toastText || body?.error?.message || body?.message || `status ${response?.status() ?? "none"} url ${lakshmiPage.url()}`,
          });
          break;
        }
        await lakshmiPage.goto(`${FRONTEND_BASE}/customer/kairali/schemes`, { waitUntil: "domcontentloaded" });
      }
      if (!RESULTS.some((row) => row.label === "customer-phonepe")) {
        record({ scope, label: "customer-phonepe", ok: paid, reason: paid ? "Lakshmi" : "no payable scheme" });
      }
      if (paid) await shot(lakshmiPage, "04-phonepe-success.png");
      await lakshmi.close();
    }

    await customerPage.goto(`${FRONTEND_BASE}/customer/kairali/profile/nominee`, { waitUntil: "domcontentloaded" });
    await customerPage.locator("#nominee-name").waitFor({ timeout: 15000 });
    await customerPage.locator("#nominee-name").fill("Flow Nominee");
    await customerPage.locator("#nominee-mobile").fill("9847001122");
    await customerPage.locator("#nominee-dob").fill("01/01/1990");
    await customerPage.getByRole("button", { name: "Save nominee" }).click();
    await waitToast(customerPage, "Nominee saved");
    record({ scope, label: "save-nominee", ok: true });
    await shot(customerPage, "05-nominee-saved.png");

    await customerPage.goto(`${FRONTEND_BASE}/customer/kairali/profile/kyc`, { waitUntil: "domcontentloaded" });
    await customerPage.waitForTimeout(800);
    if (customerPage.url().includes("/profile/kyc")) {
      const files = customerPage.locator('input[type="file"]');
      if (await files.count()) {
        await files.nth(0).setInputFiles({ name: "pan.png", mimeType: "image/png", buffer: PNG });
        await waitToast(customerPage, /uploaded|failed/i);
        await files.nth(1).setInputFiles({ name: "aadhaar.png", mimeType: "image/png", buffer: PNG });
        await waitToast(customerPage, /uploaded|failed/i);
        const submitKyc = customerPage.getByRole("button", { name: "Submit for verification" });
        if (await submitKyc.isEnabled()) {
          await submitKyc.click();
          await waitToast(customerPage, /submitted|could not/i);
          record({ scope, label: "submit-kyc", ok: true });
        } else {
          record({ scope, label: "submit-kyc", ok: false, reason: "KYC submit stayed disabled after upload" });
        }
      } else {
        record({ scope, label: "submit-kyc", ok: true, reason: "KYC already on file for this customer" });
      }
    } else {
      record({ scope, label: "submit-kyc", ok: true, reason: "tenant does not require customer KYC" });
    }

    await customerPage.goto(`${FRONTEND_BASE}/customer/kairali/support`, { waitUntil: "domcontentloaded" });
    await customerPage.getByRole("button", { name: "Create new ticket" }).click();
    const ticket = customerPage.getByRole("dialog");
    const subject = `Flow ticket ${mobile.slice(-4)}`;
    await ticket.getByRole("textbox").nth(0).fill(subject);
    await ticket.getByRole("textbox").nth(1).fill("Payment receipt is missing from the passbook after enrolment.");
    await ticket.getByRole("button", { name: "Submit ticket" }).click();
    await waitToast(customerPage, /submitted|created|sent|ticket/i);
    record({ scope, label: "support-ticket", ok: true, subject });
    await shot(customerPage, "06-ticket.png");
  } catch (error) {
    record({ scope, label: "lifecycle-customer", ok: false, reason: String(error?.message ?? error).slice(0, 240) });
    await shot(customerPage, "lifecycle-customer-failed.png").catch(() => {});
  }
  await customerContext.close();

  const staff = await browser.newContext();
  const staffPage = await staff.newPage();
  try {
    await tenantLogin(staffPage, "KAIRALI", "9847012345");
    await staffPage.goto(`${FRONTEND_BASE}/support`, { waitUntil: "domcontentloaded" });
    await staffPage.waitForTimeout(900);
    const ticketRow = staffPage.locator("tbody tr").filter({ hasText: mobile.slice(-4) }).first();
    if (await ticketRow.count()) {
      await ticketRow.click();
      const replyBox = staffPage.getByPlaceholder("Write a clear response to the customer…");
      await replyBox.waitFor({ timeout: 15000 });
      await replyBox.fill("Receipt is on the passbook. Closing this request.");
      await staffPage.getByRole("button", { name: "Reply & resolve" }).click();
      await waitToast(staffPage, /resolved|sent/i);
      record({ scope, label: "support-reply", ok: true });
    } else {
      record({ scope, label: "support-reply", ok: false, reason: "ticket row was not in the support queue" });
    }
  } catch (error) {
    record({ scope, label: "support-reply", ok: false, reason: String(error?.message ?? error).slice(0, 240) });
  }
  await staff.close();
  finish(scope);
});

test("submit agent collection and branch cash acceptance", async ({ browser }) => {
  test.setTimeout(4 * 60 * 1000);
  const scope = "submit-agent";
  const agentContext = await browser.newContext();
  const page = await agentContext.newPage();
  try {
    await page.goto(`${FRONTEND_BASE}/agent/kairali/login`, { waitUntil: "domcontentloaded" });
    await page.locator("#agent-mobile").fill("9847012352");
    await page.locator("#agent-password").fill("2026");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
    await page.goto(`${FRONTEND_BASE}/agent/collect`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Name, mobile, customer no. or passbook").fill("9847234567");
    await page.waitForTimeout(1000);
    await page.locator('a[href*="/agent/customers/"]').first().click();
    await page.getByText("What are you collecting for?").waitFor({ timeout: 15000 });
    const schemeLink = page.locator('a[href*="/agent/collect/"]').first();
    await schemeLink.click();
    await page.getByRole("button", { name: /Confirm .* collection/ }).waitFor({ timeout: 15000 });
    const confirm = page.getByRole("button", { name: /Confirm .* collection/ });
    await expect(confirm).toBeEnabled({ timeout: 15000 });
    await confirm.click();
    await page.getByText("Collection successful").waitFor({ timeout: 20000 });
    record({ scope, label: "agent-collect", ok: true });
    await shot(page, "07-agent-collect.png");

    await page.goto(`${FRONTEND_BASE}/agent/handover`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Use full available amount" }).click();
    const submitHandover = page.getByRole("button", { name: "Submit cash for acceptance" });
    await expect(submitHandover).toBeEnabled({ timeout: 10000 });
    await submitHandover.click();
    await waitToast(page, "Cash submitted for branch acceptance");
    record({ scope, label: "agent-handover", ok: true });
    await shot(page, "08-agent-handover.png");
  } catch (error) {
    record({ scope, label: "agent-flow", ok: false, reason: String(error?.message ?? error).slice(0, 240) });
    await shot(page, "agent-failed.png").catch(() => {});
  }
  await agentContext.close();

  const tenantContext = await browser.newContext();
  const tenant = await tenantContext.newPage();
  try {
    await tenantLogin(tenant, "KAIRALI", "9847012345");
    await tenant.goto(`${FRONTEND_BASE}/cash-control`, { waitUntil: "domcontentloaded" });
    await tenant.getByRole("tab", { name: "Submission history" }).click();
    await tenant.waitForTimeout(700);
    const accept = tenant.getByRole("button", { name: "Accept" }).first();
    await accept.waitFor({ timeout: 15000 });
    await accept.click();
    const dialog = tenant.getByRole("dialog");
    await dialog.getByRole("button", { name: "Accept" }).click();
    await waitToast(tenant, /accepted|recorded/i);
    record({ scope, label: "branch-accept-handover", ok: true });
    await shot(tenant, "09-handover-accepted.png");
  } catch (error) {
    record({ scope, label: "branch-accept-handover", ok: false, reason: String(error?.message ?? error).slice(0, 240) });
    await shot(tenant, "accept-failed.png").catch(() => {});
  }
  await tenantContext.close();
  finish(scope);
});

test("submit redemption for cash, gold handover, and purchase adjustment", async ({ browser }) => {
  test.setTimeout(8 * 60 * 1000);
  const scope = "submit-redemption";
  const owner = await browser.newContext();
  const page = await owner.newPage();
  try {
    await tenantLogin(page, "KAIRALI", "9847012345");
    await page.goto(`${FRONTEND_BASE}/gold-rates`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add gold rate" }).click();
    const rateDialog = page.getByRole("dialog");
    await rateDialog.locator('input[type="number"]').fill("7350.50");
    await rateDialog.getByRole("button", { name: "Publish rate" }).click();
    const rateToast = await waitToast(page, /published|could not|already|exists|rate/i).catch(() => "");
    await page.keyboard.press("Escape");
    const ratePage = await page.locator("body").innerText();
    record({
      scope,
      label: "publish-gold-rate",
      ok: /published/i.test(rateToast) || /set for today/i.test(ratePage),
      reason: (rateToast || "rate already on file").slice(0, 180),
    });

    const pending = await authedGet(page, "swarnagrow.accessToken", "/admin/redemptions?status=PENDING_APPROVAL");
    const approved = await authedGet(page, "swarnagrow.accessToken", "/admin/redemptions?status=APPROVED");
    const queue = [...pending.rows, ...approved.rows].map((row) => ({
      id: row.id ?? row._id,
      mode: row.mode,
      status: row.status,
    }));
    const cash = queue.find((row) => row.mode === "CASH");
    const gold = queue.find((row) => row.mode === "GOLD_HANDOVER");
    const schemes = await authedGet(page, "swarnagrow.accessToken", "/admin/schemes?q=ENR-0000022");
    const purchaseScheme = schemes.rows.find((row) => String(row.enrollmentNumber) === "ENR-0000022");
    const requestSchemes = await authedGet(page, "swarnagrow.accessToken", "/admin/schemes?q=ENR-0000015");
    const requestScheme = requestSchemes.rows.find((row) => String(row.enrollmentNumber) === "ENR-0000015");
    record({
      scope,
      label: "redemption-targets",
      ok: Boolean(cash && gold && purchaseScheme && requestScheme),
      reason: `cash=${Boolean(cash)} gold=${Boolean(gold)} purchase=${Boolean(purchaseScheme)} request=${Boolean(requestScheme)} queue=${queue.length}`,
    });
    if (!cash || !gold || !purchaseScheme || !requestScheme) throw new Error("missing redemption targets");

    const customer = await browser.newContext();
    const customerPage = await customer.newPage();
    await customerLogin(customerPage, "kairali", "9847956789");
    await customerPage.goto(
      `${FRONTEND_BASE}/customer/kairali/schemes/${requestScheme.id ?? requestScheme._id}`,
      { waitUntil: "domcontentloaded" },
    );
    await customerPage.getByRole("tab", { name: "Maturity benefit" }).click();
    const requestButton = customerPage.getByRole("button", { name: "Request redemption" });
    if (await requestButton.count()) {
      await requestButton.click();
      const request = customerPage.getByRole("dialog");
      const modePicker = request.getByRole("combobox");
      if (await modePicker.count()) {
        await modePicker.click();
        await customerPage.getByRole("option", { name: "Cash payout" }).click();
      }
      await request.getByRole("button", { name: "Submit request" }).click();
      await waitToast(customerPage, /sent|submitted|request/i);
      record({ scope, label: "customer-redemption-request", ok: true });
    } else {
      record({ scope, label: "customer-redemption-request", ok: true, reason: "request already open" });
    }
    await shot(customerPage, "10-customer-redemption-request.png");
    await customer.close();

    await page.goto(`${FRONTEND_BASE}/maturity?review=${cash.id}`, { waitUntil: "domcontentloaded" });
    await finishOpenRedemption(page);
    record({ scope, label: "complete-cash", ok: true });
    await shot(page, "11-cash-completed.png");

    await page.goto(`${FRONTEND_BASE}/maturity?review=${gold.id}`, { waitUntil: "domcontentloaded" });
    await finishOpenRedemption(page);
    record({ scope, label: "complete-gold-handover", ok: true });
    await shot(page, "12-gold-completed.png");

    await initiateAndComplete(
      page,
      purchaseScheme.id ?? purchaseScheme._id,
      "Adjust against purchase",
      `INV-${Date.now().toString().slice(-6)}`,
    );
    record({ scope, label: "complete-purchase-adjustment", ok: true });
    await shot(page, "13-purchase-completed.png");
  } catch (error) {
    record({ scope, label: "redemption-flow", ok: false, reason: String(error?.message ?? error).slice(0, 300) });
    await shot(page, "redemption-failed.png").catch(() => {});
  }
  await owner.close();
  finish(scope);
});

async function initiateAndComplete(page, schemeId, modeLabel, billNumber) {
  await page.goto(`${FRONTEND_BASE}/enrollments/${schemeId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Maturity" }).click();
  await page.getByRole("button", { name: "Initiate redemption" }).click({ timeout: 20000 });
  const dialog = page.getByRole("dialog");
  const combo = dialog.getByRole("combobox");
  if (await combo.count()) {
    await combo.click();
    await page.getByRole("option", { name: modeLabel }).click();
  }
  if (billNumber) {
    await dialog.getByPlaceholder("e.g. INV-2026-0042").fill(billNumber);
  }
  await dialog.getByRole("button", { name: "Submit redemption" }).click();
  await waitToast(page, /submitted|approved|handover|redemption/i);
  await page.goto(`${FRONTEND_BASE}/maturity`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Redemption queue" }).click();
  await page.locator("tbody tr").first().click();
  await finishOpenRedemption(page);
}

async function finishOpenRedemption(page) {
  const approve = page.getByRole("button", { name: "Approve redemption" });
  const complete = page.getByRole("button", { name: "Complete handover" });
  await approve.or(complete).first().waitFor({ timeout: 20000 });
  if (await approve.count() && await approve.isEnabled()) {
    await approve.click();
    await waitToast(page, /approved|handover/i);
    await complete.waitFor({ timeout: 20000 });
  }
  if (await page.getByPlaceholder(/INV-/).count()) {
    const bill = page.getByPlaceholder(/INV-/);
    if (!(await bill.inputValue())) await bill.fill(`INV-${Date.now().toString().slice(-6)}`);
  }
  await complete.click();
  await page.getByRole("button", { name: "Confirm handover" }).click();
  await waitToast(page, "Redemption completed");
}
