/**
 * Phase 1 AUD-20 browser checks — real API (no RTK mocks).
 */
/* global window, CustomEvent */
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3123";
const API = (process.env.API_BASE ?? "http://localhost:4051/api/v1").replace("127.0.0.1", "localhost");
const FIXTURE_PATH =
  process.env.PHASE1_BROWSER_FIXTURE ??
  path.resolve(__dirname, "../evidence/remediation/phase1-browser-fixture.json");

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
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
  if (![200, 201, 202].includes(requestOtp.status())) {
    throw new Error(`OTP request failed: ${requestOtp.status()} ${await requestOtp.text()}`);
  }
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
  if (verify.status() !== 200) {
    throw new Error(`OTP verify failed: ${verify.status()} ${await verify.text()}`);
  }
  const body = await verify.json();
  await page.goto(`${FRONTEND}/customer/${side.tenantSlug}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ access, refresh }) => {
      localStorage.setItem("swarnagrow.customer.accessToken", access);
      localStorage.setItem("swarnagrow.customer.refreshToken", refresh);
      window.dispatchEvent(new CustomEvent("swarnagrow:customer-tokens-updated"));
    },
    { access: body.data.accessToken, refresh: body.data.refreshToken },
  );
}

async function assertVisible(page, pattern, _label) {
  const loc = page.getByText(pattern);
  await loc.first().waitFor({ state: "visible", timeout: 45_000 });
}

async function _assertHidden(page, pattern) {
  const loc = page.getByText(pattern);
  if (await loc.count()) {
    if (await loc.first().isVisible()) throw new Error(`Unexpected visible: ${pattern}`);
  }
}

async function assertTenantMismatchGate(page, fx) {
  const homeResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("/app/home") && response.status() === 200) {
      homeResponses.push(response.url());
    }
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2_000);
  const binding = await page.evaluate(async ({ api, tenantBId }) => {
    const token = localStorage.getItem("swarnagrow.customer.accessToken");
    if (!token) return { error: "missing access token" };
    const profileRes = await fetch(`${api}/app/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const profileJson = await profileRes.json();
    return {
      profileTenantId: profileJson.data?.tenantId ?? null,
      tenantBId,
      profileOk: profileRes.status === 200,
    };
  }, { api: API, tenantBId: fx.tenantB.tenantId });
  if (binding.error) throw new Error(binding.error);
  if (!binding.profileOk) throw new Error("Profile bootstrap failed during mismatch check");
  if (String(binding.profileTenantId) === String(binding.tenantBId)) {
    throw new Error("Profile tenant matched URL tenant while session belongs to another store");
  }
  if (homeResponses.length) {
    throw new Error("Protected /app/home returned 200 while URL tenant differs from session tenant");
  }
  const bodyText = await page.locator("body").innerText();
  if (/Alice TenantA|Good morning, Alice/i.test(bodyText)) {
    throw new Error("Tenant A identity leaked on tenant B URL");
  }
}

(async () => {
  const fx = loadFixture();
  const browser = await chromium.launch({ headless: true });
  const failures = [];

  async function run(name, fn) {
    try {
      await fn();
      process.stdout.write(`✔ ${name}\n`);
    } catch (err) {
      failures.push({ name, error: err?.message ?? String(err) });
      process.stdout.write(`✖ ${name}\n  ${err?.message ?? err}\n`);
    }
  }

  await run("tenant mismatch blocks protected home", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await apiOtpLogin(page, fx, "tenantA");
    await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
    await assertVisible(page, /Alice/i, "tenant A");
    await page.goto(`${FRONTEND}/customer/${fx.tenantB.tenantSlug}`, { waitUntil: "domcontentloaded" });
    await assertTenantMismatchGate(page, fx);
    await page.close();
  });

  await run("shared context: second tab tenant B with A session", async () => {
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    await apiOtpLogin(pageA, fx, "tenantA");
    await pageA.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
    await assertVisible(pageA, /Alice/i, "tenant A home");
    await pageB.goto(`${FRONTEND}/customer/${fx.tenantB.tenantSlug}`, { waitUntil: "domcontentloaded" });
    await assertTenantMismatchGate(pageB, fx);
    await ctx.close();
  });

  await run("shared context: live token replacement preserves payment session", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await apiOtpLogin(page, fx, "tenantA");
    await page.evaluate(() => {
      sessionStorage.setItem(
        "swarnagrow.customerPaymentSession",
        JSON.stringify({ kind: "intent", intentId: "pint_test", startedAt: Date.now() }),
      );
    });
    const side = fx.tenantA;
    const mobile = side.customerMobile.replace(/^\+91/, "");
    const requestOtp = await page.request.post(`${API}/public/auth/otp/request`, {
      headers: { "X-Idempotency-Key": randomUUID(), "content-type": "application/json" },
      data: {
        tenantCode: side.tenantCode,
        mobile,
        purpose: "LOGIN",
        deviceId: "phase1-playwright-relogin",
      },
    });
    const otpId = (await requestOtp.json()).data.otpId;
    const verify = await page.request.post(`${API}/public/auth/otp/verify`, {
      headers: { "X-Idempotency-Key": randomUUID(), "content-type": "application/json" },
      data: {
        tenantCode: side.tenantCode,
        mobile,
        otpId,
        otp: fx.otpCode,
        purpose: "LOGIN",
        deviceId: "phase1-playwright-relogin",
      },
    });
    const tokens = (await verify.json()).data;
    await page.evaluate(
      ({ access, refresh }) => {
        localStorage.setItem("swarnagrow.customer.accessToken", access);
        localStorage.setItem("swarnagrow.customer.refreshToken", refresh);
        window.dispatchEvent(new CustomEvent("swarnagrow:customer-tokens-updated"));
      },
      { access: tokens.accessToken, refresh: tokens.refreshToken },
    );
    await page.goto(`${FRONTEND}/customer/${side.tenantSlug}`, { waitUntil: "domcontentloaded" });
    const raw = await page.evaluate(() => sessionStorage.getItem("swarnagrow.customerPaymentSession"));
    if (!raw || !raw.includes("pint_test")) {
      throw new Error("Payment session cleared after same-tenant token replacement");
    }
    await ctx.close();
  });

  await run("same-tenant navigation keeps payment marker", async () => {
    const page = await browser.newPage();
    await apiOtpLogin(page, fx, "tenantA");
    await page.evaluate(() => sessionStorage.setItem("swarnagrow.phase1.payment-marker", "keep-me"));
    await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}/profile`, { waitUntil: "domcontentloaded" });
    const marker = await page.evaluate(() => sessionStorage.getItem("swarnagrow.phase1.payment-marker"));
    if (marker !== "keep-me") throw new Error("Marker cleared on in-tenant navigation");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.close();
  });

  await run("public tenant branding without login", async () => {
    const page = await browser.newPage();
    await page.goto(`${FRONTEND}/customer/${fx.tenantB.tenantSlug}/login`, { waitUntil: "domcontentloaded" });
    await assertVisible(page, /Phase1/i, "branding");
    await page.close();
  });

  await run("mounted same-tenant token swap revalidates with profile Authorization", async () => {
    const page = await browser.newPage();
    const profileRequests = [];
    page.on("request", (req) => {
      if (req.url().includes("/app/profile") && req.method() === "GET") {
        profileRequests.push(req.headers().authorization ?? "");
      }
    });
    await apiOtpLogin(page, fx, "tenantA");
    await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, {
      waitUntil: "domcontentloaded",
    });
    await assertVisible(page, /Alice/i, "home before token swap");
    profileRequests.length = 0;
    const side = fx.tenantA;
    const mobile = side.customerMobile.replace(/^\+91/, "");
    const requestOtp = await page.request.post(`${API}/public/auth/otp/request`, {
      headers: { "X-Idempotency-Key": randomUUID(), "content-type": "application/json" },
      data: {
        tenantCode: side.tenantCode,
        mobile,
        purpose: "LOGIN",
        deviceId: "phase1-mounted-swap",
      },
    });
    const otpId = (await requestOtp.json()).data.otpId;
    const verify = await page.request.post(`${API}/public/auth/otp/verify`, {
      headers: { "X-Idempotency-Key": randomUUID(), "content-type": "application/json" },
      data: {
        tenantCode: side.tenantCode,
        mobile,
        otpId,
        otp: fx.otpCode,
        purpose: "LOGIN",
        deviceId: "phase1-mounted-swap",
      },
    });
    const tokens = (await verify.json()).data;
    await page.evaluate(
      ({ access, refresh }) => {
        localStorage.setItem("swarnagrow.customer.accessToken", access);
        localStorage.setItem("swarnagrow.customer.refreshToken", refresh);
        window.dispatchEvent(new CustomEvent("swarnagrow:customer-tokens-updated"));
      },
      { access: tokens.accessToken, refresh: tokens.refreshToken },
    );
    await page.waitForResponse(
      (res) => res.url().includes("/app/profile") && res.status() === 200,
      { timeout: 45_000 },
    );
    await assertVisible(page, /Alice/i, "home after mounted token swap");
    const authedProfile = profileRequests.some((h) => h.startsWith("Bearer "));
    if (!authedProfile) {
      throw new Error("Mounted token swap did not refetch /app/profile with Bearer authorization");
    }
    await page.close();
  });

  await run("bootstrap loads protected home with Authorization", async () => {
    const page = await browser.newPage();
    const homeHits = [];
    page.on("request", (req) => {
      if (req.url().includes("/app/home") && req.method() === "GET") {
        homeHits.push(req.headers().authorization ?? "");
      }
    });
    await apiOtpLogin(page, fx, "tenantA");
    await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "networkidle", timeout: 60_000 });
    await assertVisible(page, /Alice/i, "home after bootstrap");
    const authed = homeHits.some((h) => h.startsWith("Bearer "));
    if (!authed) throw new Error("Protected /app/home did not run with Bearer token after bootstrap");
    await page.close();
  });

  await run("cross-tenant account replacement clears payment session", async () => {
    const page = await browser.newPage();
    await apiOtpLogin(page, fx, "tenantA");
    await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
    await assertVisible(page, /Alice/i, "tenant A before switch");
    await page.evaluate(() => {
      sessionStorage.setItem(
        "swarnagrow.customerPaymentSession",
        JSON.stringify({ kind: "intent", intentId: "pint_cross", startedAt: Date.now() }),
      );
    });
    await apiOtpLogin(page, fx, "tenantB");
    await page.goto(`${FRONTEND}/customer/${fx.tenantB.tenantSlug}`, { waitUntil: "domcontentloaded" });
    await assertVisible(page, /Bob/i, "tenant B home");
    const raw = await page.evaluate(() => sessionStorage.getItem("swarnagrow.customerPaymentSession"));
    if (raw?.includes("pint_cross")) {
      throw new Error("Payment session from tenant A survived cross-tenant replacement");
    }
    await page.close();
  });

  await run("payment session survives reload on same account", async () => {
    const page = await browser.newPage();
    await apiOtpLogin(page, fx, "tenantA");
    await page.evaluate(() => {
      sessionStorage.setItem(
        "swarnagrow.customerPaymentSession",
        JSON.stringify({ kind: "link", linkId: "plink_reload", startedAt: Date.now() }),
      );
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    const raw = await page.evaluate(() => sessionStorage.getItem("swarnagrow.customerPaymentSession"));
    if (!raw?.includes("plink_reload")) {
      throw new Error("Payment session lost after reload on same account");
    }
    await page.close();
  });

  await run("UI OTP login same tenant", async () => {
    const page = await browser.newPage();
    await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}/login`, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="mobile"], #mobile').first().waitFor({ state: "visible", timeout: 60_000 });
    await page.locator('input[name="mobile"], #mobile').first().fill(fx.tenantA.customerMobile.replace(/^\+91/, ""));
    await page.getByRole("button", { name: /Send secure OTP/i }).click();
    await page.locator("#otp").fill(fx.otpCode);
    await page.getByRole("button", { name: /Verify & continue/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 45_000 });
    await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, { waitUntil: "domcontentloaded" });
    await assertVisible(page, /Alice/i, "home");
    await page.close();
  });

  await run(
    "mounted cross-tenant token swap delays profile; stale cache does not confirm until B resolves",
    async () => {
      const page = await browser.newPage();
      let releaseProfile;
      const profileGate = new Promise((resolve) => {
        releaseProfile = resolve;
      });
      let stallProfileAfterTokenSwap = false;
      await page.route("**/api/v1/app/profile", async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        if (stallProfileAfterTokenSwap) {
          await profileGate;
          stallProfileAfterTokenSwap = false;
        }
        await route.continue();
      });
      await apiOtpLogin(page, fx, "tenantA");
      await page.goto(`${FRONTEND}/customer/${fx.tenantA.tenantSlug}`, {
        waitUntil: "domcontentloaded",
      });
      await assertVisible(page, /Alice/i, "tenant A home before token swap");
      await page.evaluate(() => {
        sessionStorage.setItem(
          "swarnagrow.customerPaymentSession",
          JSON.stringify({ kind: "intent", intentId: "pint_delay_ab", startedAt: Date.now() }),
        );
      });
      const bSide = fx.tenantB;
      const bMobile = bSide.customerMobile.replace(/^\+91/, "");
      const ro = await page.request.post(`${API}/public/auth/otp/request`, {
        headers: { "X-Idempotency-Key": randomUUID(), "content-type": "application/json" },
        data: {
          tenantCode: bSide.tenantCode,
          mobile: bMobile,
          purpose: "LOGIN",
          deviceId: "phase1-delay-profile-b",
        },
      });
      const otpIdB = (await ro.json()).data.otpId;
      const vb = await page.request.post(`${API}/public/auth/otp/verify`, {
        headers: { "X-Idempotency-Key": randomUUID(), "content-type": "application/json" },
        data: {
          tenantCode: bSide.tenantCode,
          mobile: bMobile,
          otpId: otpIdB,
          otp: fx.otpCode,
          purpose: "LOGIN",
          deviceId: "phase1-delay-profile-b",
        },
      });
      const bTokens = (await vb.json()).data;
      stallProfileAfterTokenSwap = true;
      await page.evaluate(
        ({ access, refresh }) => {
          localStorage.setItem("swarnagrow.customer.accessToken", access);
          localStorage.setItem("swarnagrow.customer.refreshToken", refresh);
          window.dispatchEvent(new CustomEvent("swarnagrow:customer-tokens-updated"));
        },
        { access: bTokens.accessToken, refresh: bTokens.refreshToken },
      );
      const start = Date.now();
      while (Date.now() - start < 8_000) {
        const leaked = await page.evaluate(() =>
          /Alice TenantA/i.test(globalThis.document?.body?.innerText ?? ""),
        );
        if (leaked) {
          throw new Error("Stale Alice UI while B profile pending");
        }
        await page.waitForTimeout(400);
      }
      releaseProfile();
      await page.waitForResponse(
        (res) => res.url().includes("/app/profile") && res.status() === 200,
        { timeout: 45_000 },
      );
      await assertVisible(page, /Different jeweller account|Bob/i, "mismatch or tenant B identity after B profile");
      const payRaw = await page.evaluate(() =>
        sessionStorage.getItem("swarnagrow.customerPaymentSession"),
      );
      if (payRaw?.includes("pint_delay_ab")) {
        throw new Error("Payment session survived delayed cross-tenant profile");
      }
      await page.close();
    },
  );

  await browser.close();
  if (failures.length) {
    process.exit(1);
  }
  process.stdout.write("All Phase 1 customer identity browser checks passed.\n");
})();
