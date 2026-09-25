import { test, expect } from "@playwright/test";
import path from "node:path";

const FRONTEND_BASE = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const OUT = path.resolve("docs/e2e-visual-screenshots/submits");

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

test("settlement preview shows paise and grams for each payout", async ({ page }) => {
  await page.goto(`${FRONTEND_BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await fillControlled(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fillControlled(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });

  await page.goto(`${FRONTEND_BASE}/enrollments/sch_01M33YWB8JF07A166F02D6MVNV`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Settlement preview" }).click();
  const cashPreview = page.getByRole("dialog");
  await expect(cashPreview.getByText("₹9,800.00").first()).toBeVisible({ timeout: 15000 });
  await expect(cashPreview.getByText("₹200.00").first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "settlement-cash-premature.png"), fullPage: true });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Close prematurely" }).click();
  const closeDialog = page.getByRole("dialog");
  await closeDialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: "Take as gold" }).click();
  await expect(closeDialog.getByText("0.604 g").first()).toBeVisible();
  await expect(closeDialog.getByText("₹9,800.00").first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "settlement-gold-handover-cash-plan.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.goto(`${FRONTEND_BASE}/enrollments/sch_01M33YWCMJ7R13QPF4ACX31T6Z`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Settlement preview" }).click();
  await expect(page.getByText("₹44,381.00").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("2.760 g").first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "settlement-gold-weight-cash.png"), fullPage: true });

  await page.getByRole("dialog").getByRole("combobox").click();
  await page.getByRole("option", { name: "Take as gold" }).click();
  await expect(page.getByText("2.735 g").first()).toBeVisible();
  await expect(page.getByText("₹44,375.38").first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "settlement-gold-weight-handover.png"), fullPage: true });
});
