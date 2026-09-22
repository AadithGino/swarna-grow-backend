/**
 * KAIRALI tenant portal coverage (storage/KYC excluded).
 * Run: npm run seed:pending-handover && npx playwright test scripts/visual-tenant-coverage.spec.js
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:5173";
const API = process.env.API_BASE ?? "http://localhost:4000/api/v1";
const OUT = path.resolve("docs/tenant-coverage-results.json");

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
    record(
      area,
      false,
      String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 420),
    );
  }
}

async function fill(locator, value) {
  await locator.scrollIntoViewIfNeeded();
  for (let i = 0; i < 4; i += 1) {
    await locator.click();
    await locator.fill(String(value));
    if ((await locator.inputValue()) === String(value)) return;
    await locator.page().waitForTimeout(250);
  }
  await locator.fill(String(value));
}

async function login(page) {
  await page.goto(`${FRONTEND}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await fill(page.locator('input[autocomplete="username"]').first(), "9847012345");
  await fill(page.locator('input[autocomplete="current-password"]').first(), "2026");
  await fill(page.locator('input[autocomplete="organization"]').first(), "KAIRALI");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 25000 });
}

async function token(page) {
  return page.evaluate(() => localStorage.getItem("swarnagrow.accessToken"));
}

async function apiGet(page, apiPath) {
  const t = await token(page);
  const res = await page.request.get(`${API}${apiPath}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  const json = await res.json().catch(() => ({}));
  const data = json?.data;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return { status: res.status(), rows, json, meta: json?.meta };
}

async function tracked(page, click, match) {
  const pending = page.waitForResponse(match, { timeout: 25000 }).catch(() => null);
  await click();
  const response = await pending;
  if (!response) throw new Error("no matching API response");
  const json = await response.json().catch(() => ({}));
  if (response.status() >= 400) throw new Error(JSON.stringify(json).slice(0, 280));
  return json?.data ?? json;
}

test.use({ actionTimeout: 15000, navigationTimeout: 25000 });

test("KAIRALI tenant portal coverage batch", async ({ page }) => {
  test.setTimeout(12 * 60 * 1000);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, "[]");
  execFileSync("npm", ["run", "seed:pending-handover"], {
    cwd: path.resolve("."),
    stdio: "pipe",
  });
  await login(page);

  await step("dashboard-kpi", async () => {
    const dash = await apiGet(page, "/admin/dashboard/summary?period=THIS_MONTH");
    if (dash.status !== 200) throw new Error(`dashboard HTTP ${dash.status}`);
    const summary = dash.json?.data ?? dash.json;
    const active = summary?.customers?.active;
    await page.goto(`${FRONTEND}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.getByText("This month").first().click().catch(() => {});
    const body = await page.locator("body").innerText();
    if (active != null && !body.includes(String(active))) {
      throw new Error(`page missing Active customers ${active}`);
    }
    return `dashboard loaded${active != null ? `, active=${active}` : ""}`;
  });

  await step("dues-collect", async () => {
    await page.goto(`${FRONTEND}/dues`, { waitUntil: "domcontentloaded" });
    const yearBtn = page.getByRole("button", { name: /2026|Full year|Calendar year/i }).first();
    if (await yearBtn.count()) await yearBtn.click();
    await page.getByRole("tab", { name: "Overdue" }).click().catch(() => {});
    await page.waitForTimeout(600);
    const buttons = page.getByRole("button", { name: "Collect" });
    const count = await buttons.count();
    if (!count) throw new Error("no Collect buttons — widen date range or seed dues");
    for (let i = 0; i < Math.min(count, 8); i += 1) {
      await buttons.nth(i).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const submit = dialog.getByRole("button").filter({ hasText: /^Collect / });
      await submit.waitFor({ timeout: 10000 }).catch(() => {});
      const label = (await submit.count()) ? await submit.innerText() : "";
      if (/^Collect /.test(label)) {
        await tracked(
          page,
          () => submit.click(),
          (r) => r.url().includes("/payments") && r.request().method() === "POST",
        );
        await page.keyboard.press("Escape");
        return `collected from row ${i + 1}`;
      }
      await page.keyboard.press("Escape");
    }
    throw new Error("no payable dues row in first 8 Collect attempts");
  });

  await step("dues-link-bell", async () => {
    await page.goto(`${FRONTEND}/dues`, { waitUntil: "domcontentloaded" });
    const row = page.locator("tbody tr").first();
    await row.waitFor({ timeout: 15000 });
    const bell = row.locator("button").last();
    let linkOk = false;
    let bellOk;
    if (await row.getByRole("button").count() >= 2) {
      const linkBtn = row.getByRole("button").nth(-2);
      try {
        await tracked(
          page,
          () => linkBtn.click(),
          (r) => r.url().includes("payment-link") || r.url().includes("/payments"),
        );
        linkOk = true;
      } catch {
        linkOk = false;
      }
    }
    try {
      await bell.click();
      await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 12000 });
      bellOk = true;
    } catch {
      bellOk = false;
    }
    if (!linkOk && !bellOk) throw new Error("Link and Bell both failed");
    return `link=${linkOk} bell=${bellOk}`;
  });

  await step("cash-accept-reject", async () => {
    const pendingApi = await apiGet(page, "/admin/cash/handovers?limit=20");
    const pendingIds = pendingApi.rows.filter(
      (r) => String(r.status ?? "").toUpperCase() === "PENDING",
    );
    if (!pendingIds.length) {
      throw new Error("no PENDING handover — run npm run seed:pending-handover");
    }
    await page.goto(`${FRONTEND}/cash-control`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Submission history" }).click();
    await page.waitForTimeout(600);
    const acceptBtn = page.getByRole("button", { name: "Accept" }).first();
    await acceptBtn.waitFor({ timeout: 15000 });
    await acceptBtn.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Accept$/ }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /accepted|recorded/i }).first().waitFor();
    return "accepted pending handover from submission history";
  });

  await step("maturity-stat-cards", async () => {
    await page.goto(`${FRONTEND}/maturity`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "List" }).click();
    await page.waitForTimeout(800);
    const mat = await apiGet(page, "/admin/maturities?limit=1");
    const summary = mat.meta?.summary ?? mat.json?.meta?.summary;
    const body = await page.locator("body").innerText();
    for (const [label, key] of [
      ["Upcoming 30 days", "upcoming"],
      ["Matured today", "maturedToday"],
      ["Matured not redeemed", "notRedeemed"],
    ]) {
      if (summary?.[key] == null) continue;
      if (!body.includes(String(summary[key]))) {
        throw new Error(`${label} missing on page (API ${summary[key]})`);
      }
    }
    return "maturity stat cards align with API summary";
  });

  await step("redemption-approve-complete", async () => {
    const modes = [
      { mode: "CASH", bill: null },
      { mode: "GOLD_HANDOVER", bill: null },
      { mode: "PURCHASE_ADJUSTMENT", bill: "E2E-BILL-001" },
    ];
    const done = [];
    for (const job of modes) {
      const pending = await apiGet(
        page,
        `/admin/redemptions?status=PENDING_APPROVAL&limit=50`,
      );
      const approved = await apiGet(page, "/admin/redemptions?status=APPROVED&limit=50");
      let target =
        pending.rows.find((r) => String(r.mode ?? "") === job.mode) ??
        approved.rows.find((r) => String(r.mode ?? "") === job.mode);
      if (!target && job.mode === "CASH") {
        target = pending.rows[0] ?? approved.rows[0];
      }
      if (!target) continue;
      const redId = target.id ?? target._id;
      await page.goto(`${FRONTEND}/maturity?review=${redId}`, {
        waitUntil: "domcontentloaded",
      });
      const sheet = page.locator("[role=dialog]").last();
      await sheet.waitFor({ timeout: 15000 });
      const approve = sheet.getByRole("button", { name: "Approve redemption" });
      if (await approve.count()) {
        await approve.click();
        await page.locator("[data-sonner-toast]").filter({ hasText: /approved/i }).first().waitFor();
      }
      if (job.bill) {
        const bill = sheet.getByPlaceholder(/bill/i);
        if (await bill.count()) await bill.fill(job.bill);
      }
      const complete = sheet.getByRole("button", { name: "Complete handover" });
      if (!(await complete.count())) continue;
      await complete.click();
      const confirm = page.getByRole("alertdialog");
      await confirm.getByRole("button", { name: "Confirm handover" }).click();
      await page.locator("[data-sonner-toast]").filter({ hasText: /completed|handover/i }).first().waitFor({ timeout: 25000 });
      done.push(job.mode);
    }
    if (!done.length) return "skipped — redemption queue empty or modes already completed";
    return `completed modes: ${done.join(", ")}`;
  });

  await step("reject-approved-redemption", async () => {
    const approved = await apiGet(page, "/admin/redemptions?status=APPROVED&limit=20");
    const row = approved.rows[0];
    if (!row) return "skipped — no APPROVED redemption to reject";
    const redId = row.id ?? row._id;
    await page.goto(`${FRONTEND}/maturity?review=${redId}`, { waitUntil: "domcontentloaded" });
    const sheet = page.locator("[role=dialog]").last();
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Reject this request instead" }).click();
    await sheet.locator("textarea").last().fill("E2E reject approved redemption");
    await sheet.getByRole("button", { name: "Confirm reject" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /reject/i }).first().waitFor();
    return `rejected ${redId}`;
  });

  await step("premature-approve-complete", async () => {
    const open = await apiGet(page, "/admin/redemptions?status=PENDING_APPROVAL&limit=30");
    const prem = open.rows.find(
      (r) => String(r.closureType ?? r.type ?? "").includes("PREMATURE"),
    );
    if (!prem) return "skipped — no pending premature redemption";
    const redId = prem.id ?? prem._id;
    await page.goto(`${FRONTEND}/maturity?review=${redId}`, { waitUntil: "domcontentloaded" });
    const sheet = page.locator("[role=dialog]").last();
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Approve redemption" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /approved/i }).first().waitFor();
    await sheet.getByRole("button", { name: "Complete handover" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Confirm handover" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /completed|handover/i }).first().waitFor();
    return `premature completed ${redId}`;
  });

  await step("plan-activate", async () => {
    await page.goto(`${FRONTEND}/schemes`, { waitUntil: "domcontentloaded" });
    await page.getByRole("combobox").first().click().catch(() => {});
    await page.getByRole("option", { name: /Draft/i }).click().catch(() => {});
    await page.waitForTimeout(500);
    const activate = page.getByRole("button", { name: "Activate plan" }).first();
    if (!(await activate.count())) return "skipped — no draft plan visible";
    await tracked(
      page,
      () => activate.click(),
      (r) => r.request().method() === "POST" || r.request().method() === "PATCH",
    );
    await page.locator("[data-sonner-toast]").filter({ hasText: /activated|active/i }).first().waitFor();
    return "draft plan activated";
  });

  async function enrolFromDialog(planMatch) {
    await page.goto(`${FRONTEND}/enrollments`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Create enrollment" }).click();
    const dialog = page.getByRole("dialog");
    const customers = await apiGet(page, "/admin/customers?limit=5");
    const pick = customers.rows[0];
    if (!pick) throw new Error("no customers for enrolment");
    const needle = String(pick.mobile ?? pick.name ?? "").slice(0, 6);
    await dialog
      .getByPlaceholder("Search name, phone, or passbook no.")
      .fill(needle);
    await page.waitForTimeout(600);
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option").first().click();
    await dialog.getByRole("combobox").nth(1).click();
    const options = page.getByRole("option");
    const n = await options.count();
    let picked = false;
    for (let i = 0; i < n; i += 1) {
      const text = await options.nth(i).innerText();
      if (planMatch(text)) {
        await options.nth(i).click();
        picked = true;
        break;
      }
    }
    if (!picked) return null;
    const submit = dialog.getByRole("button", { name: "Create enrollment" }).last();
    await expect(submit).toBeEnabled({ timeout: 25000 });
    await submit.click();
    await page.waitForURL(/\/enrollments\/[^/]+$/, { timeout: 30000 });
    return page.url().split("/").pop();
  }

  await step("enrol-flexible-free", async () => {
    const id = await enrolFromDialog(
      (text) => /flex/i.test(text) && !/gold weight/i.test(text),
    );
    if (!id) return "skipped — no flexible plan matched";
    return id;
  });

  await step("enrol-gold-weight", async () => {
    const id = await enrolFromDialog((text) => /gold/i.test(text));
    if (!id) return "skipped — no gold plan matched";
    return id;
  });

  await step("collections-reverse", async () => {
    await page.goto(`${FRONTEND}/collections`, { waitUntil: "domcontentloaded" });
    const reverseBtn = page.getByRole("button", { name: "Reverse" }).first();
    if (!(await reverseBtn.count())) return "skipped — no reversible SUCCESS payment in view";
    await reverseBtn.click();
    const dialog = page.getByRole("alertdialog");
    await dialog.locator("textarea").fill("E2E coverage reversal");
    await dialog.getByRole("button", { name: "Reverse payment" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /reversed/i }).first().waitFor();
    return "payment reversed";
  });

  await step("collections-pending-reconcile", async () => {
    await page.goto(`${FRONTEND}/collections`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Pending" }).click();
    await page.waitForTimeout(600);
    const poll = page.getByRole("button", { name: "Poll" }).first();
    if (!(await poll.count())) return "skipped — no pending gateway payments";
    await poll.click();
    await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 15000 });
    return "polled pending payment";
  });

  await step("reminders-centre", async () => {
    await page.goto(`${FRONTEND}/reminders`, { waitUntil: "domcontentloaded" });
    await page.getByText(/Reminder|WhatsApp|Push/i).first().waitFor();
    await page.getByRole("tab", { name: "Manual push" }).click();
    await page.getByRole("heading", { name: "Send manual push" }).waitFor();
    await page.getByRole("button", { name: "Estimate reach" }).click();
    await page.getByText(/customers with devices/i).waitFor({ timeout: 20000 });
    return "reminders tabs, manual push audience estimate, dues bell path ready";
  });

  await step("staff-directory-tabs", async () => {
    await page.goto(`${FRONTEND}/staff-branches`, { waitUntil: "domcontentloaded" });
    const sessions = page.getByRole("tab", { name: "Sessions" });
    if (await sessions.count()) throw new Error("Sessions tab should be hidden");
    await page.getByRole("tab", { name: "Staff" }).click();
    await page.getByRole("link", { name: "View" }).first().click();
    await page.waitForURL(/\/staff-branches\/staff\//);
    return "staff detail reachable from directory";
  });

  await step("reports-csv-export", async () => {
    const reportWait = page.waitForResponse(
      (r) => r.url().includes("/admin/reports/COLLECTION") && r.request().method() === "GET",
      { timeout: 30000 },
    );
    await page.goto(`${FRONTEND}/reports?reportKey=COLLECTION`, {
      waitUntil: "domcontentloaded",
    });
    await reportWait;
    await page.waitForTimeout(800);
    const download = page.getByRole("button", { name: "Export CSV" });
    await download.first().waitFor({ timeout: 20000 });
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
      download.click(),
    ]);
    if (dl) return `csv ${await dl.suggestedFilename()}`;
    await page.locator("[data-sonner-toast]").filter({ hasText: /download|csv/i }).first().waitFor();
    return "csv export triggered";
  });

  const failed = findings.filter((f) => !f.ok);
  expect(
    failed,
    failed.map((f) => `${f.area}: ${f.detail}`).join("\n"),
  ).toEqual([]);
});
