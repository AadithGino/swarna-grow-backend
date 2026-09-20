import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/lib/ids.js";
import { Redemption } from "../src/models/index.js";
import {
  ClosureType,
  RedemptionMode,
  RedemptionStatus,
} from "../src/constants/enums.js";
import { redemptionPeriodSummary } from "../src/services/redemption-period-summary.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

test("purchase adjustment settlement does not count as cash payout", async () => {
  const { tenant, branch } = await seedTenantUser();
  const scope = { tenantId: tenant._id };
  const completedAt = new Date("2026-09-10T12:00:00+05:30");
  await Redemption.create([
    {
      _id: createId("red"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: createId("scheme"),
      customerId: createId("customer"),
      closureType: ClosureType.MATURITY_REDEMPTION,
      mode: RedemptionMode.CASH,
      status: RedemptionStatus.COMPLETED,
      settlementPaise: 500_000,
      cashOutPaise: 500_000,
      completedAt,
    },
    {
      _id: createId("red"),
      tenantId: tenant._id,
      branchId: branch._id,
      schemeId: createId("scheme"),
      customerId: createId("customer"),
      closureType: ClosureType.MATURITY_REDEMPTION,
      mode: RedemptionMode.PURCHASE_ADJUSTMENT,
      status: RedemptionStatus.COMPLETED,
      settlementPaise: 300_000,
      cashOutPaise: 0,
      handoverValuePaise: 0,
      completedAt,
    },
  ]);

  const summary = await redemptionPeriodSummary(scope, {
    from: "2026-09-01",
    to: "2026-09-30",
  });

  assert.equal(summary.cashSettlementPaise, 500_000);
  assert.equal(summary.settlementPaise, 500_000);
  assert.equal(summary.count, 2);
});
