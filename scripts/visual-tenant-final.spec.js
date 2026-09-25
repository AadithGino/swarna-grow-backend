import { test, expect } from "@playwright/test";
import fs from "node:fs";

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const OUT = "/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend/docs/tenant-final-results.json";
const PNG = "/tmp/swarna-audit-kyc.png";
const PLAN_ID = "spl_01M3499VN8DYM1YJ34DF1THPQH";
const STAFF_ID = "usr_01M346ZGHHV4RXJ8ZEER8HH44R";
const CUSTOMER_ID = "cus_01M346YX7FX9YV3A1M3GD76NH2";
const CLOSE_SCHEME = "sch_01M33YWB8JF07A166F02D6MVNV";

fs.writeFileSync(
  PNG,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const findings = [];
function record(area, ok, detail) {
  findings.push({ area, ok, detail });
  fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));
  console.log(`${ok ? "OK" : "FAIL"} ${area}: ${detail}`);
}
async function step(area, fn) {
  try {
    record(area, true, await fn());
  } catch (error) {
    record(area, false, String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 400));
  }
}
async function fill(locator, value) {
  await locator.scrollIntoViewIfNeeded();
  await locator.fill(String(value));
}
async function tracked(page, click, match) {
  const pending = page.waitForResponse(match, { timeout: 20000 }).catch(() => null);
  await click();
  const response = await pending;
  if (!response) throw new Error("no matching API response");
  const json = await response.json().catch(() => ({}));
  if (response.status() >= 400) throw new Error(JSON.stringify(json).slice(0, 280));
  return json?.data ?? json;
}
async function login(page) {
  await page.goto(`${FRONTEND}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  for (const [sel, value] of [
    ['input[autocomplete="username"]', "9847012345"],
    ['input[autocomplete="current-password"]', "2026"],
    ['input[autocomplete="organization"]', "KAIRALI"],
  ]) {
    await fill(page.locator(sel).first(), value);
  }
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
}

test.use({ actionTimeout: 12000, navigationTimeout: 20000 });

test("finish remaining tenant actions", async ({ page }) => {
  test.setTimeout(240000);
  await login(page);

  await step("scheme-edit", async () => {
    await page.goto(`${FRONTEND}/schemes/${PLAN_ID}/edit`, { waitUntil: "domcontentloaded" });
    const form = page.locator("fieldset");
    await form.getByText("Display name").waitFor();
    await fill(form.locator("input").nth(2), "Edited Audit Plan AU95774");
    for (let i = 0; i < 12; i += 1) {
      const save = page.getByRole("button", { name: "Save changes" });
      if (await save.count()) {
        await tracked(page, () => save.click(), (response) => response.request().method() === "PATCH");
        return "display name Edited Audit Plan AU95774";
      }
      await page.getByRole("button", { name: "Continue" }).click();
    }
    throw new Error("save not reached");
  });

  await step("staff-permissions", async () => {
    await page.goto(`${FRONTEND}/staff-branches`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Sessions" }).click();
    const sessions = await page.locator("body").innerText();
    await page.getByRole("tab", { name: "Permission audit" }).click();
    const audit = await page.locator("body").innerText();
    await page.goto(`${FRONTEND}/staff-branches/staff/${STAFF_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Active sessions").first().waitFor();
    await page.getByRole("tab", { name: "Permissions" }).click();
    const perms = await page.locator("body").innerText();
    const placeholder = /sessions register/i.test(sessions) && /permissions register/i.test(audit);
    const detail = /staff\.|customer\.|scheme\./i.test(perms);
    if (!detail) throw new Error("staff detail permissions did not list permission keys");
    if (placeholder) {
      throw new Error("staff detail lists permissions and active sessions; the directory Sessions and Permission audit tabs are placeholders");
    }
    return "sessions and permissions are live";
  });

  await step("customer-kyc", async () => {
    await page.goto(`${FRONTEND}/customers/${CUSTOMER_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Customer" }).click();
    await page.getByRole("button", { name: /Upload & review|Review documents/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "PAN" }).click();
    await fill(dialog.getByPlaceholder("ABCDE1234F"), "ABCDE1234F");
    await page.getByRole("button", { name: "Upload PAN card" }).click();
    await dialog.locator('input[type="file"]').last().setInputFiles(PNG);
    const uploaded = dialog.getByText("PAN image uploaded");
    const toast = page.locator("[data-sonner-toast]").last();
    await Promise.race([
      uploaded.waitFor({ timeout: 15000 }),
      toast.waitFor({ timeout: 15000 }),
    ]);
    if (!(await uploaded.count())) throw new Error(await toast.innerText());
    await dialog.getByRole("button", { name: "Submit for review" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /submitted|could not/i }).waitFor();
    const submitted = await page.locator("[data-sonner-toast]").last().innerText();
    if (!/submitted/i.test(submitted)) throw new Error(submitted);
    await page.getByRole("button", { name: "Review documents" }).click();
    await tracked(
      page,
      () => page.getByRole("dialog").getByRole("button", { name: "Mark verified" }).click(),
      (response) => response.url().includes("kyc") && response.request().method() !== "GET",
    );
    return "KYC verified";
  });

  await step("dues-collect", async () => {
    await page.goto(`${FRONTEND}/dues`, { waitUntil: "domcontentloaded" });
    const buttons = page.getByRole("button", { name: "Collect" });
    const count = await buttons.count();
    if (!count) throw new Error("no Collect button on dues");
    let last = "no payable due";
    for (let i = 0; i < Math.min(count, 6); i += 1) {
      await buttons.nth(i).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const submit = dialog.getByRole("button").filter({ hasText: /^Collect |Not payable/ });
      await submit.waitFor({ timeout: 8000 }).catch(() => {});
      const label = (await submit.count()) ? await submit.innerText() : await dialog.innerText();
      if (/^Collect /.test(label)) {
        const payment = await tracked(
          page,
          () => submit.click(),
          (response) => response.url().includes("/payments") && response.request().method() === "POST",
        );
        return `${payment.receiptNo ?? payment.id ?? "payment"} ${label}`;
      }
      last = label.replace(/\s+/g, " ").slice(0, 180);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    throw new Error(last);
  });

  await step("cash-accept-reject", async () => {
    await page.goto(`${FRONTEND}/cash-control`, { waitUntil: "domcontentloaded" });
    const from = page.locator('input[type="date"]').first();
    if (await from.count()) await fill(from, "2026-01-01");
    await page.getByRole("tab", { name: "Submission history" }).click();
    await page.waitForTimeout(800);
    const pending = page.getByRole("row").filter({ hasText: /Pending/i });
    if (!(await pending.count())) {
      throw new Error((await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 240));
    }
    await pending.first().getByRole("button", { name: "Accept" }).click();
    let dialog = page.getByRole("dialog");
    await tracked(
      page,
      () => dialog.getByRole("button", { name: "Accept", exact: true }).click(),
      (response) => response.url().includes("/cash-handovers/") && response.request().method() !== "GET",
    );
    await page.waitForTimeout(500);
    const next = page.getByRole("row").filter({ hasText: /Pending/i }).first();
    await next.getByRole("button", { name: "Accept" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Reject" }).click();
    await fill(dialog.locator("textarea"), "Drawer count does not match this handover.");
    const rejected = await tracked(
      page,
      () => dialog.getByRole("button", { name: "Confirm reject" }).click(),
      (response) => response.url().includes("/cash-handovers/") && response.request().method() !== "GET",
    );
    return `accepted one handover and rejected ${rejected.status ?? rejected.id ?? "another"}`;
  });

  await step("premature-closure", async () => {
    await page.goto(`${FRONTEND}/enrollments/${CLOSE_SCHEME}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Close prematurely" }).click();
    const dialog = page.getByRole("dialog");
    const remarks = dialog.getByPlaceholder("Why is this scheme being closed early?");
    const error = dialog.getByText(/Could not load|not eligible|zero/i);
    await Promise.race([
      remarks.waitFor({ timeout: 15000 }),
      error.waitFor({ timeout: 15000 }),
    ]);
    if (await error.count()) throw new Error(await dialog.innerText());
    await remarks.fill("Customer asked to close this scheme early.");
    const boxes = dialog.getByRole("checkbox");
    for (let i = 0; i < (await boxes.count()); i += 1) await boxes.nth(i).click();
    const result = await tracked(
      page,
      () => dialog.getByRole("button", { name: "Confirm closure" }).click(),
      (response) => response.url().includes(CLOSE_SCHEME) && response.request().method() !== "GET",
    );
    return result.redemptionNumber ?? result.status ?? "closed";
  });

  await step("reject-approved-redemption", async () => {
    await page.goto(`${FRONTEND}/maturity`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Redemption queue" }).click();
    await page.getByText("P6-LOCK-699650").first().click();
    const sheet = page.locator("[role=dialog]").last();
    await sheet.getByRole("button", { name: "Reject this request instead" }).click();
    await sheet.locator("textarea").last().fill("The approved rate no longer matches what we will pay.");
    const result = await tracked(
      page,
      () => sheet.getByRole("button", { name: "Reject", exact: true }).click(),
      (response) => response.url().includes("/redemptions/") && response.request().method() !== "GET",
    );
    if (result.status !== "REJECTED") throw new Error(JSON.stringify(result).slice(0, 200));
    return "P6-LOCK-699650 redemption REJECTED";
  });

  const failed = findings.filter((row) => !row.ok);
  expect(failed, failed.map((row) => `${row.area}: ${row.detail}`).join("\n")).toEqual([]);
});
