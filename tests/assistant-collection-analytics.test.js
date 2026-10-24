import test from "node:test";
import assert from "node:assert/strict";
import "./global-test-db-serial.js";
import { PaymentMode, PaymentStatus } from "../src/constants/enums.js";
import { Payment } from "../src/models/index.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser } from "./helpers/db.js";
import {
  mergeCollectionAnalyticsPlan,
  parseCompareModesFromQuestion,
  buildCollectionDailyAction,
} from "../src/services/assistant/collection-analytics-plan.js";
import {
  resolveCollectionAnalyticsAction,
  validateAndNormalizeAssistantPlan,
} from "../src/services/assistant/assistant-plan.js";
import { resolveActionWithHistory } from "../src/services/assistant/follow-up.js";
import { aggregateCollectionDailyByModeAccounting } from "../src/lib/collection-daily-accounting.js";
import { collectionPeriodBaseMatch } from "../src/lib/collection-period-aggregation.js";
import { bundlePayloadFromCollectionDaily, runCollectionDailyAssistant } from "../src/services/assistant/collection-daily-assistant.service.js";
const TODAY = "2026-10-24";

test("parseCompareModesFromQuestion maps UPI separately from gateway", () => {
  assert.deepEqual(parseCompareModesFromQuestion("cash and upi collection"), [
    PaymentMode.CASH,
    PaymentMode.UPI,
  ]);
  assert.deepEqual(parseCompareModesFromQuestion("online gateway payments"), [
    PaymentMode.ONLINE_GATEWAY,
  ]);
  assert.equal(parseCompareModesFromQuestion("cash and online payment").includes(PaymentMode.UPI), false);
});

test("four-message reproduction plan merge retains Cash/UPI and day grain", () => {
    const ctx = { todayIst: TODAY, lastResolvedPlan: null, history: [] };
    const q1 = "Daily collection in the last 5 days";
    const a1 = validateAndNormalizeAssistantPlan(
      q1,
      { kind: "collectionDaily", filters: { period: "THIS_MONTH" } },
      ctx,
    );
    assert.equal(a1.filters.from, "2026-10-20");
    assert.equal(a1.filters.to, TODAY);

    const plan1 = { action: a1 };
    const q2 = "what about on upi and cash collection comparion in last 5 days";
    const a2 = resolveActionWithHistory(
      q2,
      [{ role: "assistant", action: a1, summary: a1.summaryText ?? "Daily collection · …" }],
      { kind: "clarify", question: "?" },
      TODAY,
      { lastResolvedPlan: plan1 },
    );
    assert.equal(a2.analytics.compareModes.includes(PaymentMode.CASH), true);
    assert.equal(a2.analytics.compareModes.includes(PaymentMode.UPI), true);
    assert.equal(a2.analytics.compareModes.includes(PaymentMode.ONLINE_GATEWAY), false);

    const q3 = "give me each 5 days detail comparsion day wise";
    const a3 = resolveActionWithHistory(q3, [{ role: "assistant", action: a2 }], a2, TODAY, {
      lastResolvedPlan: { action: a2 },
    });
    assert.deepEqual(a3.analytics.compareModes, a2.analytics.compareModes);
    assert.equal(a3.analytics.timeGrain, "day");

    const q4 = "here cash and upi wise comparon of each days collection in last 5 days";
    const a4 = resolveCollectionAnalyticsAction(q4, a3, {
      todayIst: TODAY,
      lastResolvedPlan: { action: a3 },
    });
    assert.equal(a4.analytics.operation, "comparison");
    assert.equal(a4.analytics.dimensions.includes("day"), true);
    assert.equal(a4.analytics.dimensions.includes("mode"), true);
});

test("day x mode accounting zero-fills and separates UPI from ONLINE_GATEWAY", async () => {
  await resetTestDb();
  const { tenant, branch, user } = await seedTenantUser({});
  const customerId = createId("cus");
  const schemeId = createId("sch");
  const baseMatch = collectionPeriodBaseMatch({ tenantId: tenant._id, branchId: branch._id });
  const from = "2026-10-20";
  const to = "2026-10-24";

  const mkPay = (mode, day, amount) => ({
    _id: createId("pay"),
    tenantId: tenant._id,
    branchId: branch._id,
    customerId,
    schemeId,
    receiptNumber: `RCP-${mode}-${day}`,
    amountPaise: amount,
    status: PaymentStatus.SUCCESS,
    mode,
    paidAt: new Date(`${day}T12:00:00+05:30`),
    collectedBy: user._id,
    source: "STAFF_APP",
  });

  await Payment.create([
    mkPay(PaymentMode.CASH, "2026-10-20", 10_000),
    mkPay(PaymentMode.UPI, "2026-10-20", 20_000),
    mkPay(PaymentMode.ONLINE_GATEWAY, "2026-10-20", 99_000),
    mkPay(PaymentMode.CASH, "2026-10-24", 5_000),
  ]);

  const matrix = await aggregateCollectionDailyByModeAccounting(
    baseMatch,
    { from, to },
    [PaymentMode.CASH, PaymentMode.UPI],
  );
  assert.equal(matrix.dates.length, 5);
  const day20Cash = matrix.cells.find((c) => c.date === "2026-10-20" && c.mode === PaymentMode.CASH);
  const day20Upi = matrix.cells.find((c) => c.date === "2026-10-20" && c.mode === PaymentMode.UPI);
  assert.equal(day20Cash.netCollectedPaise, 10_000);
  assert.equal(day20Upi.netCollectedPaise, 20_000);

  const action = buildCollectionDailyAction({
    bounds: { from, to },
    analytics: {
      operation: "comparison",
      metric: "net_collected",
      timeGrain: "day",
      dimensions: ["day", "mode"],
      compareModes: [PaymentMode.CASH, PaymentMode.UPI],
    },
  });
  const req = {
    auth: { tenantId: tenant._id, role: "TENANT_OWNER" },
    scope: { tenantId: tenant._id, branchId: branch._id },
    query: {},
  };
  const result = await runCollectionDailyAssistant(req, action);
  const bundle = bundlePayloadFromCollectionDaily(result, action);
  assert.match(bundle.summaryText, /comparison/i);
  assert.equal(bundle.table.columns.some((c) => c.key === "cashNet"), true);
  assert.equal(bundle.table.columns.some((c) => c.key === "upiNet"), true);
  assert.equal(bundle.table.columns.some((c) => c.key === "online_gatewayNet"), false);
  assert.equal(bundle.chart.series.length, 2);
});
