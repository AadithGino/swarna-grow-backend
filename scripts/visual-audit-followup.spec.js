import { test } from "@playwright/test";
import fs from "node:fs";

const FRONTEND_BASE = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const OUT = "docs/e2e-audit-followup.json";

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

test("read dashboard and maturity cards, create branch, approve open redemption", async ({ page }) => {
  test.setTimeout(120000);
  const notes = [];
  await page.goto(`${FRONTEND_BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await fillControlled(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fillControlled(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });

  await page.goto(`${FRONTEND_BASE}/dashboard`, { waitUntil: "networkidle" });
  await page.getByText("Active customers").first().waitFor({ timeout: 15000 });
  const cards = ["Active customers", "Open enrollments", "Matured schemes", "Open redemptions", "Overdue schemes", "Today"];
  const dashboardText = await page.locator("body").innerText();
  notes.push({
    area: "dashboard-visible",
    text: cards.map((label) => {
      const index = dashboardText.indexOf(label);
      return index < 0 ? `${label}: missing` : dashboardText.slice(Math.max(0, index - 40), index + label.length + 40).replace(/\s+/g, " ");
    }),
  });

  await page.goto(`${FRONTEND_BASE}/maturity`, { waitUntil: "networkidle" });
  await page.getByText("Upcoming 30 days").first().waitFor({ timeout: 15000 });
  const maturityText = await page.locator("body").innerText();
  notes.push({
    area: "maturity-visible",
    text: ["Upcoming 30 days", "Matured today", "Term-ended incomplete", "Matured not redeemed", "Liability due", "Gold liability"].map((label) => {
      const index = maturityText.indexOf(label);
      return index < 0 ? `${label}: missing` : maturityText.slice(index, index + 80).replace(/\s+/g, " ");
    }),
  });

  const code = `B${String(Date.now()).slice(-4)}`;
  await page.goto(`${FRONTEND_BASE}/staff-branches`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Add branch" }).click();
  const dialog = page.getByRole("dialog");
  await fillControlled(dialog.getByPlaceholder("Panampilly Nagar"), `Audit Branch ${code}`);
  await fillControlled(dialog.getByPlaceholder("PMN"), code);
  const create = dialog.getByRole("button", { name: "Create branch" });
  notes.push({ area: "branch-button", enabled: await create.isEnabled() });
  await create.click();
  const toast = page.locator("[data-sonner-toast]").first();
  const toastText = await toast.waitFor({ timeout: 10000 }).then(() => toast.innerText()).catch(async () => {
    return await dialog.innerText();
  });
  notes.push({ area: "branch-toast", text: toastText.slice(0, 300) });

  await page.goto(`${FRONTEND_BASE}/maturity`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Redemption queue" }).click();
  const row = page.getByRole("row").filter({ hasText: "P6-LOCK-699650" }).first();
  await row.waitFor({ timeout: 15000 });
  await row.click();
  await page.getByRole("button", { name: "Approve redemption" }).click();
  const approved = await page.locator("[data-sonner-toast]").filter({ hasText: /approved/i }).first()
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  notes.push({ area: "approve", ok: approved });
  fs.writeFileSync(OUT, JSON.stringify(notes, null, 2));
});
