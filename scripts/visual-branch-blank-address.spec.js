import { test, expect } from "@playwright/test";

const FRONTEND_BASE = process.env.FRONTEND_BASE ?? "http://localhost:5173";

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

test("blank branch address is saved", async ({ page }) => {
  const code = `C${String(Date.now()).slice(-4)}`;
  const name = `Blank Address ${code}`;
  await page.goto(`${FRONTEND_BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await fillControlled(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fillControlled(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });

  await page.goto(`${FRONTEND_BASE}/staff-branches`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Add branch" }).click();
  const dialog = page.getByRole("dialog");
  await fillControlled(dialog.getByPlaceholder("Panampilly Nagar"), name);
  await fillControlled(dialog.getByPlaceholder("PMN"), code);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/admin/branches") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create branch" }).click();
  const response = await responsePromise;
  const body = await response.json().catch(() => ({}));
  expect(response.status(), JSON.stringify(body).slice(0, 300)).toBeLessThan(400);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: name })).toBeVisible();
  await page.getByRole("tab", { name: "Branches" }).click();
  await expect(page.getByRole("row").filter({ hasText: code }).first()).toBeVisible();
});
