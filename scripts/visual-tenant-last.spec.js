import { test } from "@playwright/test";

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const findings = [];
function record(area, ok, detail) {
  findings.push({ area, ok, detail });
  console.log(`${ok ? "OK" : "FAIL"} ${area}: ${detail}`);
}
async function step(area, fn) {
  try { record(area, true, await fn()); }
  catch (error) { record(area, false, String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300)); }
}
async function fill(locator, value) {
  await locator.click();
  await locator.fill(value);
  if ((await locator.inputValue()) !== value) {
    await locator.fill(value);
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
async function tracked(page, click, match) {
  const pending = page.waitForResponse(match, { timeout: 20000 }).catch(() => null);
  await click();
  const response = await pending;
  if (!response) throw new Error("no matching API response");
  const json = await response.json().catch(() => ({}));
  if (response.status() >= 400) throw new Error(JSON.stringify(json).slice(0, 240));
  return json?.data ?? json;
}

test.use({ actionTimeout: 15000, navigationTimeout: 20000 });
test("dues, cash, and reject", async ({ page }) => {
  test.setTimeout(120000);
  await login(page);

  await step("dues-collect", async () => {
    await page.goto(`${FRONTEND}/dues`, { waitUntil: "domcontentloaded" });
    const collect = page.getByRole("button", { name: "Collect" });
    await collect.first().waitFor({ timeout: 12000 });
    const count = await collect.count();
    for (let i = 0; i < Math.min(count, 5); i += 1) {
      await collect.nth(i).click();
      const dialog = page.getByRole("dialog");
      const submit = dialog.getByRole("button", { name: /^Collect / });
      if (await submit.count()) {
        const payment = await tracked(
          page,
          () => submit.click(),
          (response) => response.url().includes("/payments") && response.request().method() === "POST",
        );
        return `${payment.receiptNo ?? payment.id} via dues row ${i + 1}`;
      }
      await page.keyboard.press("Escape");
    }
    throw new Error("opened dues rows but none were payable");
  });

  await step("cash-accept-reject", async () => {
    await page.goto(`${FRONTEND}/cash-control`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Submission history" }).click();
    const accept = page.getByRole("button", { name: "Accept" });
    const resolve = page.getByRole("button", { name: "Resolve" });
    if (await accept.count()) {
      await accept.first().click();
      const dialog = page.getByRole("dialog");
      const accepted = await tracked(
        page,
        () => dialog.getByRole("button", { name: "Accept", exact: true }).click(),
        (response) => response.url().includes("/cash-handovers/") && response.request().method() !== "GET",
      );
      return `accepted ${accepted.status ?? accepted.id}`;
    }
    if (await resolve.count()) {
      const resolved = await tracked(
        page,
        () => resolve.first().click(),
        (response) => response.url().includes("/cash-handovers/") && response.request().method() !== "GET",
      );
      return `no pending handover left to accept or reject; resolved the open discrepancy ${resolved.status ?? ""}`.trim();
    }
    throw new Error("submission history has no Accept or Resolve action");
  });

  await step("reject-approved-redemption", async () => {
    await page.goto(`${FRONTEND}/maturity`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Redemption queue" }).click();
    await page.getByText("P6-LOCK-699650").first().click();
    const sheet = page.locator("[role=dialog]").last();
    await sheet.getByText("Reject this request instead").click();
    await sheet.locator("textarea").last().fill("The approved rate no longer matches what we will pay.");
    const result = await tracked(
      page,
      () => sheet.getByRole("button", { name: "Confirm reject" }).click(),
      (response) => response.url().includes("/redemptions/") && response.request().method() !== "GET",
    );
    if (result.status !== "REJECTED") throw new Error(JSON.stringify(result).slice(0, 180));
    return "rejected";
  });

  await step("complete-premature", async () => {
    await page.goto(`${FRONTEND}/maturity`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Redemption queue" }).click();
    await page.getByText("ENR-0000001").first().click();
    const sheet = page.locator("[role=dialog]").last();
    const approve = sheet.getByRole("button", { name: "Approve redemption" });
    if (await approve.count()) {
      await tracked(
        page,
        () => approve.click(),
        (response) => response.url().includes("/redemptions/") && response.request().method() !== "GET",
      );
    }
    const complete = sheet.getByRole("button", { name: "Complete handover" });
    await complete.waitFor({ timeout: 10000 });
    const result = await tracked(
      page,
      () => complete.click(),
      (response) => response.url().includes("/redemptions/") && response.request().method() !== "GET",
    );
    return result.status ?? "completed";
  });
});
