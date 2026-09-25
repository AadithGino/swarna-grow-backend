import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const FRONTEND_BASE = process.env.FRONTEND_BASE ?? "http://127.0.0.1:3000";
const OUT_DIR =
  process.env.VISUAL_E2E_OUT_DIR ??
  "/Users/aadithgino/Developer/Swarna Grow/swarnagrow-backend/docs/e2e-visual-screenshots";

fs.mkdirSync(OUT_DIR, { recursive: true });

async function capture(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, name), fullPage: true });
}

async function openHydrated(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
}

/** Retry until React keeps the value after hydration. */
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

test("tenant portal login click-run", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHydrated(page, `${FRONTEND_BASE}/login`);
  await capture(page, "01-tenant-login-page.png");

  await fillControlled(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fillControlled(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
  await capture(page, "02-tenant-after-login.png");
  await context.close();
});

test("agent portal login click-run", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${FRONTEND_BASE}/agent/kairali/login`, { waitUntil: "domcontentloaded" });
  await capture(page, "03-agent-login-page.png");

  await page.locator("#agent-mobile").fill("9847012352");
  await page.locator("#agent-password").fill("2026");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForLoadState("networkidle");

  await expect(page).not.toHaveURL(/\/agent\/kairali\/login$/);
  await capture(page, "04-agent-after-login.png");
  await context.close();
});

test("customer portal otp click-run", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${FRONTEND_BASE}/customer/kairali/login`, { waitUntil: "domcontentloaded" });
  await capture(page, "05-customer-login-page.png");

  await page.locator("#mobile").fill("9847123456");
  await page.getByRole("button", { name: "Send secure OTP" }).click();
  await page.waitForLoadState("networkidle");

  await page.locator("#otp").fill("123456");
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await page.waitForLoadState("networkidle");

  await expect(page).not.toHaveURL(/\/customer\/kairali\/login$/);
  await capture(page, "06-customer-after-login.png");
  await context.close();
});

test("platform portal login click-run", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHydrated(page, `${FRONTEND_BASE}/platform/login`);
  await capture(page, "07-platform-login-page.png");

  await fillControlled(page.locator('input[type="email"]').first(), "ops@platform.com");
  await fillControlled(page.locator('input[autocomplete="current-password"]').first(), "1234");
  await expect(page.getByRole("button", { name: "Sign in securely" })).toBeEnabled();
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
  await capture(page, "08-platform-after-login.png");
  await context.close();
});

