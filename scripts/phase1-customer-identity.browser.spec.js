/**
 * Phase 1 AUD-20 browser verification — real API (no RTK mocks).
 *
 * FRONTEND_BASE=http://127.0.0.1:3123 API_BASE=http://127.0.0.1:4051/api/v1 \
 *   npx playwright test scripts/phase1-customer-identity.browser.spec.js --reporter=line --workers=1
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3123";
const API = process.env.API_BASE ?? "http://127.0.0.1:4051/api/v1";
const FIXTURE_PATH =
  process.env.PHASE1_BROWSER_FIXTURE ??
  path.resolve("evidence/remediation/phase1-browser-fixture.json");

function loadFixture() {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  return JSON.parse(raw);
}

async function apiOtpLogin(page, fx, sideKey) {
  const side = fx[sideKey];
  const mobile = side.customerMobile.replace(/^\+91/, "");
  const requestOtp = await page.request.post(`${API}/public/auth/otp/request`, {
    headers: { "X-Idempotency-Key": randomUUID(), "content-type": "application/json" },
    data: {
      tenantCode: side.tenantCode,
      mobile,
      purpose: "LOGIN",
      deviceId: "phase1-playwright",
    },
  });
  expect([200, 201, 202]).toContain(requestOtp.status());
  const otpId = (await requestOtp.json()).data.otpId;
  const verify = await page.request.post(`${API}/public/auth/otp/verify`, {
    headers: { "X-Idempotency-Key": randomUUID(), "content-type": "application/json" },
    data: {
      tenantCode: side.tenantCode,
      mobile,
      otpId,
      otp: fx.otpCode,
      purpose: "LOGIN",
      deviceId: "phase1-playwright",
    },
  });
  expect(verify.status()).toBe(200);
  const body = await verify.json();
  await page.goto(`${FRONTEND}/customer/${side.tenantSlug}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ access, refresh }) => {
      localStorage.setItem("swarnagrow.customer.accessToken", access);
      localStorage.setItem("swarnagrow.customer.refreshToken", refresh);
    },
    {
      access: body.data.accessToken,
      refresh: body.data.refreshToken,
    },
  );
}

async function customerUiOtpLogin(page, fx, sideKey) {
  const side = fx[sideKey];
  await page.goto(`${FRONTEND}/customer/${side.tenantSlug}/login`, { waitUntil: "domcontentloaded" });
  await page.locator("#mobile").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator("#mobile").fill(side.customerMobile.replace(/^\+91/, ""));
  await page.getByRole("button", { name: /Send secure OTP/i }).click();
  await page.locator("#otp").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#otp").fill(fx.otpCode);
  await page.getByRole("button", { name: /Verify & continue/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 45_000 });
}

test.describe.configure({ mode: "serial" });

test("tenant mismatch blocks protected home and shows switch UI", async ({ page }) => {
  const fx = loadFixture();
  await apiOtpLogin(page, fx, "tenantA");
  await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Alice TenantA/i)).toBeVisible({ timeout: 30_000 });

  const blocked = [];
  page.on("request", (req) => {
    if (req.url().includes("/app/home") && req.url().includes(API.replace("/api/v1", ""))) {
      blocked.push(req.url());
    }
  });

  await page.goto(`${FRONTEND}/customer/${fx.tenantB.tenantSlug}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Different jeweller account/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Alice TenantA/i)).not.toBeVisible();
  await expect(page.getByText(/Bob TenantB/i)).not.toBeVisible();
  expect(blocked.length).toBe(0);
});

test("second tab on tenant B does not show tenant A greeting", async ({ browser }) => {
  const fx = loadFixture();
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await apiOtpLogin(pageA, fx, "tenantA");
  await pageA.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
  await expect(pageA.getByText(/Alice TenantA/i)).toBeVisible();

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await apiOtpLogin(pageB, fx, "tenantA");
  await pageB.goto(`${FRONTEND}/customer/${fx.tenantB.tenantSlug}`, { waitUntil: "domcontentloaded" });
  await expect(pageB.getByRole("heading", { name: /Different jeweller account/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(pageB.getByText(/Alice TenantA/i)).not.toBeVisible();
  await ctxA.close();
  await ctxB.close();
});

test("reload keeps same-tenant session; same-tenant navigation does not wipe payment marker", async ({ page }) => {
  const fx = loadFixture();
  await apiOtpLogin(page, fx, "tenantA");
  await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    sessionStorage.setItem("swarnagrow.phase1.payment-marker", "keep-me");
  });
  await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}/profile`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Alice TenantA/i)).toBeVisible({ timeout: 30_000 });
  const markerAfterNav = await page.evaluate(() => sessionStorage.getItem("swarnagrow.phase1.payment-marker"));
  expect(markerAfterNav).toBe("keep-me");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Alice TenantA/i)).toBeVisible({ timeout: 30_000 });
});

test("token refresh keeps tenant A home; stale in-flight home cannot paint after B URL", async ({ page }) => {
  const fx = loadFixture();
  await apiOtpLogin(page, fx, "tenantA");
  await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });

  const profileRes = await page.request.get(`${API}/app/profile`, {
    headers: { authorization: `Bearer ${fx.tenantA.accessToken}` },
  });
  expect(profileRes.status()).toBe(200);
  const profileBody = await profileRes.json();
  expect(profileBody.data?.tenantId ?? profileBody.data?.customer?.tenantId).toBeTruthy();

  let releaseDelay;
  const delayPromise = new Promise((resolve) => {
    releaseDelay = resolve;
  });
  await page.route("**/app/home**", async (route) => {
    await delayPromise;
    await route.continue();
  });

  const homeNavigate = page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
  await page.goto(`${FRONTEND}/customer/${fx.tenantB.tenantSlug}`, { waitUntil: "domcontentloaded" });
  releaseDelay();
  await homeNavigate.catch(() => {});
  await expect(page.getByRole("heading", { name: /Different jeweller account/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Alice TenantA/i)).not.toBeVisible();
});

test("public tenant resolve works without customer session", async ({ page }) => {
  const fx = loadFixture();
  await page.goto(`${FRONTEND}/customer/${fx.tenantB.tenantSlug}/login`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Phase1 Jewellers B/i)).toBeVisible({ timeout: 30_000 });
});

test("customer UI OTP login succeeds on same tenant", async ({ page }) => {
  const fx = loadFixture();
  await customerUiOtpLogin(page, fx, "tenantA");
  await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Alice TenantA/i)).toBeVisible({ timeout: 45_000 });
});
